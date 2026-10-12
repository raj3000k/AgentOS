"""Run after installing AgentOS and pulling qwen3:8b."""

from agentos import Agent, tool


@tool
def word_count(text: str) -> int:
    """Count whitespace-separated words in text."""
    return len(text.split())


if __name__ == "__main__":
    agent = Agent(name="WordCounter", tools=[word_count],
                  instructions="Use word_count to count words, then give a short answer.")
    result = agent.run("How many words are in 'local agents are useful'?")
    print(result.content)
