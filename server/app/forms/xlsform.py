"""XLSForm (.xlsx) to XForm XML, via pyxform."""

from __future__ import annotations

import os
import tempfile

from pyxform.errors import PyXFormError
from pyxform.xls2xform import convert


class XLSFormError(Exception):
    """The upload could not be turned into a form. `messages` are human-readable."""

    def __init__(self, messages: list[str]):
        self.messages = list(messages)
        super().__init__("; ".join(self.messages))


def to_xform(xlsx_bytes: bytes) -> str:
    """Convert XLSForm bytes to XForm XML; raise XLSFormError on any bad input."""
    if not xlsx_bytes:
        raise XLSFormError(["The uploaded file is empty."])
    warnings: list[str] = []
    path = None
    try:
        fd, path = tempfile.mkstemp(suffix=".xlsx")
        with os.fdopen(fd, "wb") as f:
            f.write(xlsx_bytes)
        result = convert(xlsform=path, warnings=warnings)
        return result.xform
    except PyXFormError as e:
        msg = str(e)
        if "supported type" in msg:  # pyxform's wording when the bytes are not a spreadsheet
            msg = "This file is not an Excel XLSForm (.xlsx) spreadsheet."
        raise XLSFormError([msg, *warnings]) from e
    except Exception as e:  # not a spreadsheet, corrupt zip, wrong shape: never a stack trace
        raise XLSFormError(
            [f"This file could not be read as an XLSForm (.xlsx) spreadsheet: {e}"]
        ) from e
    finally:
        if path is not None:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
