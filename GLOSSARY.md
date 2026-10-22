# Durable bot conversations

This vocabulary distinguishes an enduring agent from the accounts, conversations and individual work associated with it.

## Language

**Bot**:
An enduring agent identity that can continue work and communicate between individual requests. Connecting to an existing bot does not create a replacement identity.
_Avoid_: Model, prompt preset, single task

**Connection**:
An authorized relationship through which a person can reach bots in an account or on a machine. Disconnecting that relationship does not stop or delete those bots.
_Avoid_: Bot, remote shutdown

**Conversation**:
A continuing exchange of messages with a bot. One bot can participate in more than one conversation.
_Avoid_: Task, model call

**Task**:
A piece of work a bot undertakes, which can continue independently of the conversation currently on screen.
_Avoid_: Conversation, bot identity

**Agent preset**:
A reusable configuration for starting an agent's work. It is not an independently running bot.
_Avoid_: Connected bot
