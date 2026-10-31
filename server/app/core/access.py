"""Who may fill which form. One definition, used by every route and by intake.

An enumerator may fill a form when EITHER
  * they are a member of the form's project (`ProjectMember`) - this is the grant the admin
    API hands out, and it covers forms added to the project later; OR
  * they hold a direct per-form `Assignment` (the older, finer-grained grant, still honoured).
Staff (admin, supervisor) are decided by `staff_form_filter` / `staff_can_see_form` below:
admin sees everything, a supervisor only the projects they are a member of.
"""

from sqlalchemy import ColumnElement, exists, false, or_, select, true
from sqlalchemy.orm import Session

from app.db.models import Assignment, Dataset, Form, ProjectMember, User


def granted_to(user_id: int) -> ColumnElement[bool]:
    """SQL condition on `Form`: this user holds a grant on the form."""
    direct = exists().where(Assignment.form_id == Form.id, Assignment.user_id == user_id)
    via_project = exists().where(
        ProjectMember.project_id == Form.project_id, ProjectMember.user_id == user_id
    )
    return or_(direct, via_project)


def has_form_grant(db: Session, user_id: int, form_pk: int) -> bool:
    return db.scalar(select(Form.id).where(Form.id == form_pk, granted_to(user_id))) is not None


def staff_form_filter(user: User) -> ColumnElement[bool]:
    """SQL condition on `Form`: this admin or supervisor may see the form. THE staff rule.

    Admin sees every form. A supervisor sees the forms in projects they are a member of
    (`ProjectMember`) and no others. Anyone else sees none. The role is the one on the `User`
    row the request loaded from the database, never a token claim. Every list query uses this
    condition and `staff_can_see_form` is the same condition for one form, so the two cannot
    drift apart.
    """
    if user.role == "admin":
        return true()
    if user.role == "supervisor":
        return exists().where(
            ProjectMember.project_id == Form.project_id, ProjectMember.user_id == user.id
        )
    return false()


def staff_can_see_form(db: Session, user: User, form_pk: int) -> bool:
    """May this admin or supervisor see this form's data (list, detail, media, exports)?"""
    return db.scalar(select(Form.id).where(Form.id == form_pk, staff_form_filter(user))) is not None


def staff_can_see_project(db: Session, user: User, project_id: int) -> bool:
    """May this admin or supervisor see or manage this project? Admin: all. Supervisor: members."""
    if user.role == "admin":
        return True
    if user.role != "supervisor":
        return False
    return (
        db.scalar(
            select(ProjectMember.id).where(
                ProjectMember.project_id == project_id, ProjectMember.user_id == user.id
            )
        )
        is not None
    )


def dataset_filter(user: User) -> ColumnElement[bool]:
    """SQL condition on `Dataset`: this person may read the dataset. THE dataset rule.

    A dataset belongs to one project (its rows are names and phone numbers of frontline
    workers). Admin reads all. A supervisor reads the datasets of projects they are a member of.
    An enumerator reads those of projects they are a member of, and of the project of any form
    they hold a direct `Assignment` on - their phone needs the lists their own forms look up.
    Writes need `staff_can_see_project` on the dataset's project, so the read and write rules
    are built on the same membership.
    """
    if user.role == "admin":
        return true()
    member = exists().where(ProjectMember.project_id == Dataset.project_id, ProjectMember.user_id == user.id)
    if user.role == "supervisor":
        return member
    if user.role == "enumerator":
        via_form = exists().where(
            Form.project_id == Dataset.project_id, Assignment.form_id == Form.id, Assignment.user_id == user.id
        )
        return or_(member, via_form)
    return false()
