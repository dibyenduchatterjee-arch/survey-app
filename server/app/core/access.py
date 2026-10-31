"""Who may fill which form. One definition, used by every route and by intake.

An enumerator may fill a form when EITHER
  * they are a member of the form's project (`ProjectMember`) - this is the grant the admin
    API hands out, and it covers forms added to the project later; OR
  * they hold a direct per-form `Assignment` (the older, finer-grained grant, still honoured).
Staff (admin, supervisor) are not decided here; see `staff_can_see_form`.
"""

from sqlalchemy import ColumnElement, exists, or_, select
from sqlalchemy.orm import Session

from app.db.models import Assignment, Form, ProjectMember, User


def granted_to(user_id: int) -> ColumnElement[bool]:
    """SQL condition on `Form`: this user holds a grant on the form."""
    direct = exists().where(Assignment.form_id == Form.id, Assignment.user_id == user_id)
    via_project = exists().where(
        ProjectMember.project_id == Form.project_id, ProjectMember.user_id == user_id
    )
    return or_(direct, via_project)


def has_form_grant(db: Session, user_id: int, form_pk: int) -> bool:
    return db.scalar(select(Form.id).where(Form.id == form_pk, granted_to(user_id))) is not None


def staff_can_see_form(db: Session, user: User, form_pk: int) -> bool:
    """May this admin or supervisor see this form's data (media, export files)?

    Today every staff member sees every form - the same rule as GET /api/forms and the
    export-start route. This is the single seam to narrow if supervisors are ever scoped
    to their own projects; the download and media routes already call it.
    """
    return user.role in ("admin", "supervisor")
