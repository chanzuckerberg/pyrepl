"""
Stream IO interposition
"""

import io

class InterposedStringIO(io.StringIO):
    def __init__(self, newline="\n", line_buffering = False, onflush=None):
        super().__init__(newline=newline)
        self._line_buffering = line_buffering
        self._onflush = onflush

    def flush(self):
        s = self.getvalue()
        self.seek(io.SEEK_SET, 0)
        self.truncate()
        if self._onflush:
            self._onflush(s)

    def write(self, s):
        super().write(s)
        if self._line_buffering and ('\n' in s or '\r' in s):
            self.flush()
