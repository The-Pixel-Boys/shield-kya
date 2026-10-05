# kya-langchain

KYA policy callback for LangChain and LangGraph agents.

```sh
pip install kya-langchain[langchain]
```

This callback evaluates every tool call through the local KYA CLI before LangChain executes it. DENY verdicts raise `KyaDenied` and block the call. ALLOW and REQUIRE_APPROVE are recorded on the KYA trail.

## Usage

```python
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate
from kya_langchain import KyaLangChainCallbackHandler

handler = KyaLangChainCallbackHandler()

agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools)
executor.invoke({"input": "..."}, config={"callbacks": [handler]})
```

The KYA CLI must be installed:

```sh
npm i -g @shield-agent/kya
```

For more, see https://shield-agent.com/docs.
