/**
 * Boss Extension — Spawn and manage sub-agents in visible tmux panes
 *
 * The orchestrator splits its view, watches agents work side by side,
 * and highlights panes that need attention.
 *
 * Depends on pi-room for peek/steer — this extension handles
 * spawning, layout, highlighting, and lifecycle.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const TMUX_PANE = process.env.TMUX_PANE;

interface SpawnedAgent {
	pane: string; // tmux pane ID like "%47"
	name: string;
	task: string;
	cwd: string;
	createdAt: string;
}

const spawned = new Map<string, SpawnedAgent>();
let bordersEnabled = false;
let bossSessionFile: string | undefined;

function paneId(pane: string): string {
	return pane.replace("%", "");
}

function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function enableBorders(pi: ExtensionAPI) {
	if (bordersEnabled) return;
	bordersEnabled = true;

	await pi.exec("tmux", ["set-window-option", "pane-border-status", "top"]);
	await pi.exec("tmux", ["set-window-option", "pane-border-format", " #{pane_title} "]);
	await pi.exec("tmux", ["select-pane", "-t", TMUX_PANE!, "-T", "boss"]);
}

async function retile(pi: ExtensionAPI) {
	try {
		const r = await pi.exec("tmux", ["display-message", "-p", "#{window_id}"]);
		const wid = r.stdout?.trim();
		if (wid) await pi.exec("tmux", ["select-layout", "-t", wid, "tiled"]);
	} catch {}
}

async function isPaneAlive(pi: ExtensionAPI, tmuxPane: string): Promise<boolean> {
	try {
		const r = await pi.exec("tmux", ["list-panes", "-s", "-F", "#{pane_id}"]);
		return (r.stdout ?? "").split("\n").includes(tmuxPane);
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	if (!TMUX_PANE) return;

	// Spawned children: set parentSession on the session header so the
	// session selector renders them as children of the boss session.
	if (process.env.PI_SPAWNED) {
		const parentSessionPath = process.env.PI_PARENT_SESSION;
		if (parentSessionPath) {
			pi.on("session_start", async (_event, ctx) => {
				const header = ctx.sessionManager.getHeader();
				if (header) {
					(header as any).parentSession = parentSessionPath;
				}
			});
		}
		return;
	}

	// Capture boss session file path on startup
	pi.on("session_start", async (_event, ctx) => {
		bossSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	});
	pi.on("session_switch", async (_event, ctx) => {
		bossSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	});

	// Boss mode definition + active agent tracking
	pi.on("before_agent_start", async (event) => {
		const sections: string[] = [];

		sections.push([
			"\n\n## Boss Mode",
			'When the user says "boss mode", break the task into independent subtasks and spawn agents immediately.',
			"Do NOT investigate or research yourself first — let the spawned agents do that in parallel.",
			"Give each agent a self-contained task description with enough context to work independently.",
		].join("\n"));

		if (spawned.size > 0) {
			const lines: string[] = [];
			for (const [id, agent] of spawned) {
				lines.push(`- pane ${id} "${agent.name}": ${agent.task.slice(0, 80)}`);
			}
			sections.push([
				"\n## Spawned Agents",
				...lines,
				"",
				"Orchestration pattern: work like an event loop, not a batch.",
				"- After spawning all agents, enter a monitoring loop: call `bash sleep 15`, then peek all agents, handle any that are done (steer, kill, highlight green), repeat until all are complete.",
				"- Do NOT wait for all agents to finish before steering any of them — as soon as ONE is ready, steer it immediately, then continue the loop.",
				"- Do NOT just spawn and report back to the user. You MUST actively monitor in a loop until all agents are done.",
				"- The loop is: sleep 15 → peek all → handle ready ones → sleep 15 → peek all → … until all done.",
			].join("\n"));
		}

		return { systemPrompt: event.systemPrompt + sections.join("") };
	});

	// Kill all spawned panes on shutdown, reset borders
	pi.on("session_shutdown", async () => {
		for (const [, agent] of spawned) {
			try {
				await pi.exec("tmux", ["kill-pane", "-t", agent.pane]);
			} catch {}
		}
		spawned.clear();
		if (bordersEnabled) {
			try {
				await pi.exec("tmux", ["set-window-option", "pane-border-status", "off"]);
			} catch {}
			bordersEnabled = false;
		}
	});

	pi.registerTool({
		name: "spawn",
		label: "Spawn",
		description: [
			"Spawn and manage sub-agents in visible tmux panes.",
			"Actions:",
			"- 'create': Split the view and spawn a new pi agent with a task. Returns the pane ID.",
			"- 'list': Show all spawned agents and whether they're alive.",
			"- 'highlight': Change a pane's background color to signal status (red = needs attention, green = done, default = clear).",
			"- 'kill': Kill a spawned agent's pane.",
			"Spawned agents auto-register in the room. Use peek(pane) to monitor, steer(pane, message) to redirect.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["create", "list", "highlight", "kill"] as const, {
				description: "What to do",
			}),
			task: Type.Optional(
				Type.String({ description: "Task prompt for the spawned agent (create action)" }),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the spawned agent (create action)" }),
			),
			name: Type.Optional(
				Type.String({ description: "Display name for the pane (create action)" }),
			),
			pane: Type.Optional(
				Type.String({ description: "Pane ID to target (highlight, kill actions)" }),
			),
			color: Type.Optional(
				StringEnum(["red", "green", "blue", "default"] as const, {
					description: "Background color for highlight action",
				}),
			),
		}),

		async execute(_toolCallId, params) {
			const { action } = params;

			if (action === "create") {
				if (!params.task) {
					return {
						content: [{ type: "text" as const, text: "Error: 'task' is required for create." }],
						details: {},
						isError: true,
					};
				}

				const name = params.name ?? `agent-${spawned.size + 1}`;
				const cwd = params.cwd ?? process.cwd();

				// Enable pane borders on first spawn
				await enableBorders(pi);

				// Split window from the boss pane, passing parent session info
				const envVars = [
					`PI_SPAWNED=1`,
					`PI_PARENT_PANE=${paneId(TMUX_PANE!)}`,
					bossSessionFile ? `PI_PARENT_SESSION=${shellEscape(bossSessionFile)}` : "",
				].filter(Boolean).join(" ");
				const cmd = `${envVars} command pi ${shellEscape(params.task)}`;
				const result = await pi.exec("tmux", [
					"split-window",
					"-d",
					"-h",
					"-t", TMUX_PANE!,
					"-c", cwd,
					"-P", "-F", "#{pane_id}",
					cmd,
				]);

				const newPane = result.stdout?.trim();
				if (!newPane) {
					return {
						content: [{ type: "text" as const, text: "Error: tmux split-window returned no pane ID." }],
						details: {},
						isError: true,
					};
				}

				// Set pane title
				await pi.exec("tmux", ["select-pane", "-t", newPane, "-T", name]);

				// Auto-arrange
				await retile(pi);

				const id = paneId(newPane);
				spawned.set(id, {
					pane: newPane,
					name,
					task: params.task,
					cwd,
					createdAt: new Date().toISOString(),
				});

				return {
					content: [{
						type: "text" as const,
						text: `Spawned "${name}" in pane ${id}. Use peek/steer to interact.`,
					}],
					details: { pane: id, name, cwd },
				};
			}

			if (action === "list") {
				if (spawned.size === 0) {
					return {
						content: [{ type: "text" as const, text: "No spawned agents." }],
						details: { count: 0 },
					};
				}

				const lines: string[] = [];
				const dead: string[] = [];

				for (const [id, agent] of spawned) {
					const alive = await isPaneAlive(pi, agent.pane);
					const status = alive ? "alive" : "dead";
					const taskPreview = agent.task.length > 60
						? agent.task.slice(0, 60) + "..."
						: agent.task;
					lines.push(`pane ${id} "${agent.name}" [${status}]: ${taskPreview}`);
					if (!alive) dead.push(id);
				}

				// Clean up dead entries
				for (const id of dead) spawned.delete(id);

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { count: lines.length, alive: lines.length - dead.length },
				};
			}

			if (action === "highlight") {
				if (!params.pane) {
					return {
						content: [{ type: "text" as const, text: "Error: 'pane' is required for highlight." }],
						details: {},
						isError: true,
					};
				}

				const colors: Record<string, string> = {
					red: "bg=colour52",
					green: "bg=colour22",
					blue: "bg=colour17",
					default: "default",
				};

				const color = params.color ?? "red";
				const style = colors[color] ?? "default";

				const agent = spawned.get(params.pane);
				const target = agent?.pane ?? `%${params.pane}`;

				await pi.exec("tmux", ["select-pane", "-t", target, "-P", style]);

				return {
					content: [{ type: "text" as const, text: `Pane ${params.pane} → ${color}` }],
					details: { pane: params.pane, color },
				};
			}

			if (action === "kill") {
				if (!params.pane) {
					return {
						content: [{ type: "text" as const, text: "Error: 'pane' is required for kill." }],
						details: {},
						isError: true,
					};
				}

				const agent = spawned.get(params.pane);
				const target = agent?.pane ?? `%${params.pane}`;
				const name = agent?.name ?? params.pane;

				try {
					await pi.exec("tmux", ["kill-pane", "-t", target]);
				} catch {}

				spawned.delete(params.pane);
				await retile(pi);

				return {
					content: [{ type: "text" as const, text: `Killed "${name}" (pane ${params.pane}).` }],
					details: { pane: params.pane },
				};
			}

			return {
				content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
				details: {},
				isError: true,
			};
		},
	});
}
