"""Python 3.10 compatibility shims.

The engine is a long-running worker that people will host wherever is cheapest —
a Debian VPS, a Railway container, an older macOS toolchain — and several of those
still ship Python 3.10. Nothing here needs 3.11 semantics, only 3.11 spellings, so
these two shims widen the deployment surface at no cost.

    StrEnum      3.11+  -> str, Enum mixin behaves identically for our use
    datetime.UTC 3.11+  -> timezone.utc is the same singleton
"""

from __future__ import annotations

import sys
from datetime import timezone

if sys.version_info >= (3, 11):
    from datetime import UTC
    from enum import StrEnum
else:  # pragma: no cover — exercised on 3.10 hosts
    from enum import Enum

    UTC = timezone.utc

    class StrEnum(str, Enum):
        """3.10 stand-in for enum.StrEnum.

        The 3.11 class guarantees `str(member) == member.value`; the plain
        `str, Enum` mixin does not, so __str__ is defined explicitly.
        """

        __str__ = str.__str__

        def __format__(self, format_spec: str) -> str:
            return str.__format__(str(self), format_spec)


__all__ = ["UTC", "StrEnum"]
