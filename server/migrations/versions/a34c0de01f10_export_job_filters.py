"""export job filters: project scope and an inclusive received_at date range

Revision ID: a34c0de01f10
Revises: 61262e3e711d
Create Date: 2026-10-31 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a34c0de01f10'
down_revision: Union[str, Sequence[str], None] = '61262e3e711d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('export_jobs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('project_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('date_from', sa.Date(), nullable=True))
        batch_op.add_column(sa.Column('date_to', sa.Date(), nullable=True))
        batch_op.alter_column('form_id', existing_type=sa.Integer(), nullable=True)
        batch_op.create_foreign_key('fk_export_jobs_project_id_projects', 'projects', ['project_id'], ['id'])


def downgrade() -> None:
    # A project-wide job has no form, so it cannot survive the NOT NULL on form_id.
    op.execute("DELETE FROM export_jobs WHERE form_id IS NULL")
    with op.batch_alter_table('export_jobs', schema=None) as batch_op:
        batch_op.drop_constraint('fk_export_jobs_project_id_projects', type_='foreignkey')
        batch_op.alter_column('form_id', existing_type=sa.Integer(), nullable=False)
        batch_op.drop_column('date_to')
        batch_op.drop_column('date_from')
        batch_op.drop_column('project_id')
