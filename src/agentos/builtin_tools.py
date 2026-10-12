"""Small side-effect-free tools suitable for a first local demo."""

import math
import operator

from .tools import tool


@tool
def calculate(a: float, operation: str, b: float) -> float:
    """Calculate two numbers. operation must be add, subtract, multiply, or divide."""
    operations = {"add": operator.add, "subtract": operator.sub,
                  "multiply": operator.mul, "divide": operator.truediv}
    if operation not in operations:
        raise ValueError("Unsupported operation")
    if abs(a) > 1e100 or abs(b) > 1e100:
        raise ValueError("Operands are too large")
    result = operations[operation](a, b)
    if not math.isfinite(result):
        raise ValueError("Result must be finite")
    return result
