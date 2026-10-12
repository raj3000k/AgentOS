"""Public exceptions for callers and the CLI."""


class AgentOSError(Exception):
    """Base class for expected AgentOS failures."""


class ProviderError(AgentOSError):
    """Ollama connection or response failure."""


class ToolError(AgentOSError):
    """Invalid tool call or unsuccessful execution."""


class RunLimitError(AgentOSError):
    """The model exhausted the configured execution budget."""
