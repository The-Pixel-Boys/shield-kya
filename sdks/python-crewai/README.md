# kya-crewai

KYA policy hook for CrewAI agents and crews.

```sh
pip install kya-crewai[crewai]
```

This step callback evaluates tool calls through the local KYA CLI before CrewAI executes them. DENY verdicts raise `KyaDenied` and block the step. ALLOW and REQUIRE_APPROVE are recorded on the KYA trail.

## Usage

```python
from crewai import Crew, Agent, Task
from kya_crewai import KyaCrewaiStepHook

hook = KyaCrewaiStepHook()

crew = Crew(
    agents=[...],
    tasks=[...],
    step_callback=hook,
)

crew.kickoff()
```

The KYA CLI must be installed:

```sh
npm i -g @shield-agent/kya
```

For more, see https://shield-agent.com/docs.
