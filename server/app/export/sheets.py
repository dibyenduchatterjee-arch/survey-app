"""Google Sheets refresh: the Sheet always shows the current state of the export.

`SheetWriter.replace` CLEARS the tab and then writes, so a row deleted or corrected upstream
disappears from the Sheet and a dashboard pointed at it stays live. Values go in as RAW, never
USER_ENTERED, so a text answer beginning "=" is stored as text and is never run as a formula.
"""

import time
from collections.abc import Callable
from typing import Any

from app.export.drive import call_with_retry


class SheetWriter:
    def __init__(self, client: Any, sleep: Callable[[float], None] = time.sleep):
        self._client = client
        self._sleep = sleep

    def replace(self, sheet_id: str, tab: str, rows: list[list[str]]) -> None:
        quoted = "'" + tab.replace("'", "''") + "'"
        values = self._client.spreadsheets().values()
        call_with_retry(
            lambda: values.clear(spreadsheetId=sheet_id, range=quoted, body={}).execute(),
            f"Sheet clear of tab {tab}",
            self._sleep,
        )
        call_with_retry(
            lambda: values.update(
                spreadsheetId=sheet_id,
                range=f"{quoted}!A1",
                valueInputOption="RAW",
                body={"values": rows},
            ).execute(),
            f"Sheet write to tab {tab}",
            self._sleep,
        )
