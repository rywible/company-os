# Company OS Design

## Workflow Engine

Fully deterministic triggers that occur without agent driven input.

Example:
An agent pushes up a PR. Event emitted: "PR_PUSHED". Event triggers 2 independent reviewer agents to leave comments on the PR. 2 events triggered: "COMMENTS_LEFT_ON_PR". when 2 independent reviews are left, triggers another event "REVIEW_COMPLETED". Retriggers original agent to address review comments. then PR can merge. (this is the general idea, not the best naming or completely specified, but it's illustrative)

## Event Database

Full, structured and ordered single event stream of relevant domain events that happen in the system.

Example:
PR_PUSHED, REVIEW_COMPLETED, GAME_PLAYTESTED, etc.

## Company Constitution

Living static document that is prepended to every single agent's context. Agents cannot modify the constitution, although they can send requests to the user to change the constitution based on evidence. Uses, the approach specified in the convo already of identity, mission, technical thesis, etc.

## Present Understanding

RAG based semantic projection of what the agents and the humans think is the present organization's understanding of itself. Based on the task assigned to an agent, relevant present understanding is semantically searched and injected into their prompt/context. the present understanding is updated through some kind of mechanism over the event database and the current state of the outstanding projects

## Foreman

This is the agent that the user talks to. They don't have to be "always on", but they do have autonomous authority over evolving the target project or projects based on the company constitution. they need a tight feedback loop with the user to keep everything on track.

## Web Interface

Incredible user interface for the user to interface with their company
