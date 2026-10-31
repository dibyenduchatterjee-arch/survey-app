"""All database models. Later tasks import from here only.

Timestamps are timezone-aware UTC. `Submission.received_at` is set by the server;
`started_at` / `finished_at` are device-reported, stored as-is, and never used for
ordering or expiry (the server never trusts a device clock).
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, object_session, relationship
from sqlalchemy.types import DateTime, TypeDecorator


def utcnow() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator):
    """Timezone-aware UTC. SQLite drops tzinfo on read; this puts it back."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime: timestamps must be timezone-aware")
        return value.astimezone(UTC)

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value


class DeviceDateTime(UTCDateTime):
    """For device-reported timestamps (started_at / finished_at).

    A phone with a wrong timezone setting can send a naive timestamp; rejecting it
    would lose the submission. A naive value is therefore assumed to be UTC and
    stored; it is never used for ordering or expiry.
    """

    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return super().process_bind_param(value, dialect)


class Base(DeclarativeBase):
    type_annotation_map = {datetime: UTCDateTime()}


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "role IN ('admin', 'supervisor', 'enumerator')", name="ck_users_role"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(150), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(50))
    full_name: Mapped[str] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(30))
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_login_at: Mapped[datetime | None]


class Form(Base):
    __tablename__ = "forms"

    id: Mapped[int] = mapped_column(primary_key=True)
    form_id: Mapped[str] = mapped_column(String(150), unique=True)
    title: Mapped[str] = mapped_column(String(255))
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    versions: Mapped[list["FormVersion"]] = relationship(back_populates="form")

    def publish(self, version: "FormVersion") -> "FormVersion":
        """Make `version` the single current version of this form."""
        for v in self.versions:
            v.is_current = False
        session = object_session(self)
        if session is not None:
            # Clear the old flag in the database before the new one is set, so the
            # one-current-version-per-form unique index never sees two.
            session.flush()
        version.is_current = True
        version.published_at = utcnow()
        self.versions.append(version)
        return version


class FormVersion(Base):
    __tablename__ = "form_versions"
    __table_args__ = (
        UniqueConstraint("form_id", "version", name="uq_form_versions_form_version"),
        # At most one current version per form, enforced by the database.
        Index(
            "uq_form_versions_one_current",
            "form_id",
            unique=True,
            sqlite_where=text("is_current = 1"),
            postgresql_where=text("is_current"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    form_id: Mapped[int] = mapped_column(ForeignKey("forms.id"))
    version: Mapped[str] = mapped_column(String(50))
    xlsform_blob: Mapped[bytes] = mapped_column(LargeBinary)
    xform_xml: Mapped[str] = mapped_column(Text)
    json_spec: Mapped[dict[str, Any]] = mapped_column(JSON)
    # NULL means uploaded but never published. Only Form.publish() sets it; nothing
    # may serve a version to a device while it is NULL.
    published_at: Mapped[datetime | None] = mapped_column(default=None)
    published_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    is_current: Mapped[bool] = mapped_column(default=False)

    form: Mapped[Form] = relationship(back_populates="versions")


class Dataset(Base):
    """Pre-load data (CSV) a form can look up from."""

    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), unique=True)
    csv_blob: Mapped[bytes] = mapped_column(LargeBinary)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class Assignment(Base):
    """Who may fill what."""

    __tablename__ = "assignments"
    __table_args__ = (Index("uq_assignment_user_form", "user_id", "form_id", unique=True),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    form_id: Mapped[int] = mapped_column(ForeignKey("forms.id"))


class Submission(Base):
    __tablename__ = "submissions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('received', 'flagged', 'approved', 'rejected')",
            name="ck_submissions_status",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # Idempotency key for the sync protocol: the database enforces it.
    uuid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    form_version_id: Mapped[int] = mapped_column(
        ForeignKey("form_versions.id"), index=True
    )
    submitted_by: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    received_at: Mapped[datetime] = mapped_column(default=utcnow)  # server-set
    device_id: Mapped[str | None] = mapped_column(String(100))
    started_at: Mapped[datetime | None] = mapped_column(DeviceDateTime)  # device-reported, stored as-is
    finished_at: Mapped[datetime | None] = mapped_column(DeviceDateTime)  # device-reported, stored as-is
    status: Mapped[str] = mapped_column(String(20), default="received", index=True)
    data_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    # Server-side validation failures; a failing submission is flagged, never dropped.
    failures_json: Mapped[list[Any] | None] = mapped_column(JSON(none_as_null=True))
    gps_lat: Mapped[float | None] = mapped_column(Float)
    gps_lon: Mapped[float | None] = mapped_column(Float)
    gps_accuracy: Mapped[float | None] = mapped_column(Float)


class RepeatRow(Base):
    __tablename__ = "repeat_rows"
    __table_args__ = (
        # A retried submission must not double its repeat rows.
        UniqueConstraint(
            "submission_id", "repeat_name", "row_index", name="uq_repeat_rows_position"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[int] = mapped_column(ForeignKey("submissions.id"), index=True)
    repeat_name: Mapped[str] = mapped_column(String(150))
    row_index: Mapped[int] = mapped_column(Integer)
    data_json: Mapped[dict[str, Any]] = mapped_column(JSON)


class MediaFile(Base):
    __tablename__ = "media_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[int] = mapped_column(ForeignKey("submissions.id"), index=True)
    question_name: Mapped[str] = mapped_column(String(150))
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(Integer)
    storage_path: Mapped[str] = mapped_column(String(500))
    sha256: Mapped[str] = mapped_column(String(64))


class AuditLog(Base):
    """Append-only: the API never updates or deletes these rows."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(default=utcnow)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(100))
    object_type: Mapped[str | None] = mapped_column(String(100))
    object_id: Mapped[str | None] = mapped_column(String(100))
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(500))
    detail_json: Mapped[dict[str, Any] | None] = mapped_column(JSON(none_as_null=True))


class ExportJob(Base):
    __tablename__ = "export_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'done', 'failed')",
            name="ck_export_jobs_status",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    form_id: Mapped[int] = mapped_column(ForeignKey("forms.id"))
    requested_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    requested_at: Mapped[datetime] = mapped_column(default=utcnow)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    drive_file_id: Mapped[str | None] = mapped_column(String(200))
    sheet_id: Mapped[str | None] = mapped_column(String(200))
    row_count: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    token_hash: Mapped[str] = mapped_column(String(128), unique=True)
    issued_at: Mapped[datetime] = mapped_column(default=utcnow)
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
    replaced_by: Mapped[int | None] = mapped_column(ForeignKey("refresh_tokens.id"))
