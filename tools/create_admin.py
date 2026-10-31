"""Create the first administrator from any working directory.

    python tools/create_admin.py create-admin --username NAME [--full-name "Full Name"]

A thin wrapper over `python -m app.cli`: it puts `server/` on the import path first, so it does
not matter where it is run from. The database and .env are located from the project root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from app.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
