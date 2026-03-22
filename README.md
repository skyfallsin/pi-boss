# pi-boss

Spawn and manage sub-agents in visible tmux panes for [pi](https://github.com/badlogic/pi-mono). The orchestrator that makes boss mode work.

## What it does

Say "boss mode" and the agent breaks your task into subtasks, spawns parallel agents in tmux split panes, monitors their progress, and steers them as needed. Each spawned agent gets its own pi instance with a self-contained task.

## Tools

### `spawn`

Four actions:

**create** — Split the view and spawn a new pi agent with a task:
```
spawn(action: "create", task: "fix the auth bug in src/login.ts", name: "auth-fix")
spawn(action: "create", task: "write tests for the API", cwd: "/path/to/project")
```

**list** — Show all spawned agents and whether they're alive:
```
spawn(action: "list")
```

**highlight** — Color a pane to signal status:
```
spawn(action: "highlight", pane: "12", color: "green")   # done
spawn(action: "highlight", pane: "12", color: "red")      # needs attention
spawn(action: "highlight", pane: "12", color: "default")  # clear
```

**kill** — Kill a spawned agent's pane:
```
spawn(action: "kill", pane: "12")
```

## Boss mode

The extension injects a "Boss Mode" instruction into the system prompt. When you say "boss mode", the agent:

1. Breaks the task into independent subtasks
2. Spawns agents in parallel (one per subtask)
3. Enters a monitoring loop: sleep → peek all → steer/kill ready ones → repeat
4. Reports back when all agents are done

Spawned agents auto-register in the room (via [pi-room](https://github.com/skyfallsin/pi-room)), so the boss can use `peek` and `steer` to interact with them.

## Install

```bash
pi install git:github.com/skyfallsin/pi-boss
```

Or clone:

```bash
git clone https://github.com/skyfallsin/pi-boss ~/.pi/agent/extensions/pi-boss
```

**Requires [pi-room](https://github.com/skyfallsin/pi-room)** for peek/steer. Install both:

```bash
pi install git:github.com/skyfallsin/pi-room
pi install git:github.com/skyfallsin/pi-boss
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [pi-room](https://github.com/skyfallsin/pi-room) (for peek/steer tools)
- tmux

## How it works

- On first spawn, enables tmux pane borders and labels the boss pane
- Splits the window horizontally and runs `pi <task>` in the new pane
- Auto-tiles panes after each spawn/kill for a clean layout
- Spawned agents get `PI_SPAWNED=1` and `PI_PARENT_PANE` env vars so they know they're children
- Session files of spawned agents link back to the boss session via `parentSession`
- On shutdown, all spawned panes are killed and borders are reset

## License

MIT
