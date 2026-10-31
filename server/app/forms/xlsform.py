"""XLSForm (.xlsx) to XForm XML, via pyxform."""

from __future__ import annotations

import io
import os
import tempfile
import zipfile

from pyxform.errors import PyXFormError
from pyxform.xls2xform import convert


class XLSFormError(Exception):
    """The upload could not be turned into a form. `messages` are human-readable."""

    def __init__(self, messages: list[str]):
        self.messages = list(messages)
        super().__init__("; ".join(self.messages))


# An .xlsx is a zip, and a zip of repeated bytes shrinks a thousandfold: 212 KB can unpack to
# 200 MB. The upload cap is on the compressed size, so the unpacked size is checked here, from
# the zip's own directory, before anything is decompressed. A real XLSForm is a few hundred KB
# of XML in about twenty parts.
MAX_UNPACKED_BYTES = 50 * 1024 * 1024
MAX_ENTRIES = 200
MAX_RATIO = 200  # per part; only applied to parts big enough for the ratio to mean anything
_RATIO_FLOOR = 1024 * 1024


def check_zip_size(xlsx_bytes: bytes) -> None:
    """Refuse a decompression bomb with a clear message; leave anything else to the converter."""
    try:
        infos = zipfile.ZipFile(io.BytesIO(xlsx_bytes)).infolist()
    except zipfile.BadZipFile:
        return  # not a zip at all: the converter reports that in its own words
    if len(infos) > MAX_ENTRIES:
        raise XLSFormError([f"This spreadsheet has too many parts ({len(infos)}; at most {MAX_ENTRIES})."])
    if sum(i.file_size for i in infos) > MAX_UNPACKED_BYTES:
        raise XLSFormError(
            [f"This spreadsheet is too large once unpacked (over {MAX_UNPACKED_BYTES // (1024 * 1024)} MB)."]
        )
    for i in infos:
        if i.file_size > _RATIO_FLOOR and i.file_size > MAX_RATIO * max(i.compress_size, 1):
            raise XLSFormError(
                [f"This spreadsheet is compressed far more than a real one ({i.filename}); it was refused."]
            )


def to_xform(xlsx_bytes: bytes) -> str:
    """Convert XLSForm bytes to XForm XML; raise XLSFormError on any bad input."""
    if not xlsx_bytes:
        raise XLSFormError(["The uploaded file is empty."])
    check_zip_size(xlsx_bytes)
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
            ["This file could not be read as an XLSForm (.xlsx) spreadsheet."]
        ) from e
    finally:
        if path is not None:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
