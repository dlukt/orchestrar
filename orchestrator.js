"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const DEFAULT_MODEL = "github-copilot/gpt-5.2-codex";
const COMMIT_MODEL = "github-copilot/gpt-5-mini";
const DEFAULT_AGENT = "build-gpt-5.2-codex";
const COMMIT_AGENT = "build";
const DEFAULT_REVIEW_COMMAND_NAME = "review-uncommited";
const DEFAULT_REVIEW_COMMAND_ARGUMENTS = "";
const DEFAULT_REVIEW_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_REVIEW_ITERATIONS = 20;

async function main() {
  const root = process.cwd();
  const docs = await resolveDocs(root);
  const planPath = docs.plan;
  const { createOpencode } = await import("@opencode-ai/sdk");

  let milestoneIndex = 0;
  while (await hasUnfinishedTasks(planPath)) {
    milestoneIndex += 1;
    logStep(`Starting milestone ${milestoneIndex}`);
    await runMilestoneCycle(createOpencode, docs, root);
  }

  logStep("All milestones completed.");
}

async function runMilestoneCycle(createOpencode, docs, root) {
  await runWorkInstance(createOpencode, docs, root);
  await runCommitInstance(createOpencode, root);
}

async function runWorkInstance(createOpencode, docs, root) {
  const { client, server } = await createOpencode({
    config: buildConfig(DEFAULT_MODEL),
  });
  try {
    const session = await unwrap(
      client.session.create({
        query: { directory: root },
        body: { title: "Milestone Orchestrator" },
      }),
      "session.create"
    );

    const sessionID = extractSessionID(session, "session.create (work instance)");
    const promptPaths = buildPromptPaths(docs, root);

    await sendPrompt(
      client,
      sessionID,
      buildMilestonePrompt(promptPaths),
      root
    );
    await waitForSessionIdle(client, sessionID, root);

    await runReviewLoop(createOpencode, client, sessionID, root);

    await sendPrompt(
      client,
      sessionID,
      buildMarkTasksPrompt(promptPaths.plan),
      root
    );
    await waitForSessionIdle(client, sessionID, root);
  } finally {
    await disposeInstance(client, server, root);
  }
}

async function runCommitInstance(createOpencode, root) {
  const { client, server } = await createOpencode({
    config: buildConfig(COMMIT_MODEL),
  });
  try {
    const session = await unwrap(
      client.session.create({
        query: { directory: root },
        body: { title: "Commit & Push" },
      }),
      "session.create"
    );

    const sessionID = extractSessionID(session, "session.create (commit instance)");
    await sendPrompt(
      client,
      sessionID,
      buildCommitPrompt(),
      root,
      COMMIT_MODEL,
      COMMIT_AGENT
    );
    await waitForSessionIdle(client, sessionID, root);
  } finally {
    await disposeInstance(client, server, root);
  }
}

async function runReviewLoop(createOpencode, client, sessionID, root) {
  const maxIterations = parseNumber(
    process.env.ORCHESTRATOR_MAX_REVIEW_ITERATIONS,
    DEFAULT_MAX_REVIEW_ITERATIONS
  );

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    logStep(`Running review (${iteration}/${maxIterations})`);
    const reviewResult = await runReviewCommand(createOpencode, root);
    if (isFindingsEmpty(reviewResult)) {
      logStep("Review clean; no findings.");
      return;
    }

    const findingsCount = Array.isArray(reviewResult.findings)
      ? reviewResult.findings.length
      : "unknown";
    logStep(`Review found ${findingsCount} issues; requesting fixes.`);
    await sendPrompt(
      client,
      sessionID,
      buildFindingsPrompt(reviewResult),
      root
    );
    await waitForSessionIdle(client, sessionID, root);
  }

  throw new Error(
    `Review loop exceeded ${maxIterations} iterations without clean results.`
  );
}

async function runReviewCommand(createOpencode, root) {
  const commandName =
    process.env.ORCHESTRATOR_REVIEW_COMMAND || DEFAULT_REVIEW_COMMAND_NAME;
  const commandArguments =
    process.env.ORCHESTRATOR_REVIEW_ARGUMENTS ||
    DEFAULT_REVIEW_COMMAND_ARGUMENTS;
  const timeoutMs = parseNumber(
    process.env.ORCHESTRATOR_REVIEW_TIMEOUT_MS,
    DEFAULT_REVIEW_TIMEOUT_MS
  );

  const { client, server } = await createOpencode({
    config: buildConfig(DEFAULT_MODEL),
  });

  try {
    const session = await unwrap(
      client.session.create({
        query: { directory: root },
        body: { title: "Review" },
      }),
      "session.create"
    );

    const sessionID = extractSessionID(session, "session.create (review instance)");
    const commandResult = await unwrap(
      client.session.command({
        path: { id: sessionID },
        query: { directory: root },
        body: {
          command: commandName,
          arguments: commandArguments,
          agent: DEFAULT_AGENT,
          model: DEFAULT_MODEL,
        },
      }),
      "session.command"
    );

    await waitForSessionIdle(client, sessionID, root, timeoutMs);

    let parts = commandResult?.parts ?? [];
    const messageID = commandResult?.info?.id;
    if (messageID) {
      const message = await unwrap(
        client.session.message({
          path: { id: sessionID, messageID },
          query: { directory: root },
        }),
        "session.message"
      );
      parts = message?.parts ?? parts;
    }

    const output = collectCommandOutput(parts);
    if (!output.trim()) {
      throw new Error("Review command produced no output.");
    }
    return extractReviewJson(output);
  } finally {
    await disposeInstance(client, server, root);
  }
}

async function sendPrompt(
  client,
  sessionID,
  text,
  root,
  modelSpec = DEFAULT_MODEL,
  agentSpec = DEFAULT_AGENT
) {
  const model = parseModelSpec(modelSpec);
  await unwrap(
    client.session.prompt({
      path: { id: sessionID },
      query: { directory: root },
      body: {
        agent: agentSpec,
        model,
        parts: [{ type: "text", text }],
      },
    }),
    "session.prompt"
  );
}

async function waitForSessionIdle(client, sessionID, root, timeoutOverrideMs) {
  const timeoutMs =
    timeoutOverrideMs ??
    parseNumber(
      process.env.ORCHESTRATOR_SESSION_TIMEOUT_MS,
      DEFAULT_SESSION_TIMEOUT_MS
    );
  const pollIntervalMs = parseNumber(
    process.env.ORCHESTRATOR_STATUS_POLL_INTERVAL_MS,
    DEFAULT_STATUS_POLL_INTERVAL_MS
  );

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statusMap = await unwrap(
      client.session.status({ query: { directory: root } }),
      "session.status"
    );
    const status = statusMap?.[sessionID];
    if (!status) {
      const knownSessions = statusMap ? Object.keys(statusMap) : [];
      const knownList = knownSessions.length ? knownSessions.join(", ") : "none";
      throw new Error(
        `Session status missing for ${sessionID}. Known sessions: ${knownList}.`
      );
    }
    if (status.type === "idle") {
      return;
    }
    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for session ${sessionID} to go idle.`);
}

async function resolveDocs(root) {
  const prd = await resolveDocPath(root, "PRD.md");
  const spec = await resolveDocPath(root, "SPEC.md");
  const plan = await resolveDocPath(root, "PLAN.md");
  return { prd, spec, plan };
}

async function resolveDocPath(root, fileName) {
  const rootPath = path.join(root, fileName);
  if (await fileExists(rootPath)) {
    return rootPath;
  }

  const docsPath = path.join(root, "docs", fileName);
  if (await fileExists(docsPath)) {
    return docsPath;
  }

  throw new Error(
    `Required file not found: ${fileName} (checked ${rootPath} and ${docsPath}).`
  );
}

function buildPromptPaths(docs, root) {
  return {
    prd: path.relative(root, docs.prd) || "PRD.md",
    spec: path.relative(root, docs.spec) || "SPEC.md",
    plan: path.relative(root, docs.plan) || "PLAN.md",
  };
}

function buildMilestonePrompt(paths) {
  return [
    "Read the product documents and implement the next unchecked milestone.",
    "",
    "Docs:",
    `- PRD: ${paths.prd}`,
    `- SPEC: ${paths.spec}`,
    `- PLAN: ${paths.plan}`,
    "",
    "Requirements:",
    "- Implement one unchecked milestone and its tasks from PLAN.md.",
    "- Do not update PLAN.md checkboxes yet.",
    "- Do not commit or push.",
    "- When finished, briefly confirm completion.",
  ].join("\n");
}

function buildFindingsPrompt(reviewJson) {
  const jsonBlock = JSON.stringify(reviewJson, null, 2);
  return [
    "The review command reported issues. Address the findings below.",
    "",
    jsonBlock,
    "",
    "After fixing the issues, wait for the next instruction.",
  ].join("\n");
}

function buildMarkTasksPrompt(planPath) {
  return [
    `Update ${planPath} by marking completed tasks with [x].`,
    "Leave incomplete tasks unchecked.",
    "Do not commit or push yet.",
    "When done, confirm the PLAN.md updates.",
  ].join("\n");
}

function buildCommitPrompt() {
  return [
    "Commit the changes with an appropriate commit message and git push.",
    "After pushing, confirm completion.",
  ].join("\n");
}

async function hasUnfinishedTasks(planPath) {
  const content = await fs.readFile(planPath, "utf8");
  return /^\s*[-*+]\s+\[\s\]/m.test(content);
}

function isFindingsEmpty(reviewJson) {
  if (!reviewJson || typeof reviewJson !== "object") {
    throw new Error("Review JSON was not an object.");
  }
  if (!Array.isArray(reviewJson.findings)) {
    throw new Error("Review JSON is missing a findings array.");
  }
  return reviewJson.findings.length === 0;
}

function extractReviewJson(output) {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("Review command produced no output.");
  }

  let index = trimmed.lastIndexOf("{");
  while (index !== -1) {
    const slice = trimmed.slice(index).trim();
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === "object" && "findings" in parsed) {
        return parsed;
      }
    } catch (error) {
      // Ignore parse failures and continue scanning earlier braces.
    }
    index = trimmed.lastIndexOf("{", index - 1);
  }

  throw new Error("Failed to parse review JSON from command output.");
}

function collectCommandOutput(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }

  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
      continue;
    }
    if (part.type === "tool" && part.state && typeof part.state === "object") {
      if (part.state.status === "completed" && typeof part.state.output === "string") {
        chunks.push(part.state.output);
      } else if (part.state.status === "error" && typeof part.state.error === "string") {
        chunks.push(part.state.error);
      }
    }
  }

  return chunks.join("\n");
}

function parseNumber(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildConfig(model) {
  return {
    model,
    permission: {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
    },
  };
}

function parseModelSpec(spec) {
  const separatorIndex = spec.indexOf("/");
  if (separatorIndex === -1) {
    throw new Error(`Invalid model spec: ${spec}`);
  }
  const providerID = spec.slice(0, separatorIndex).trim();
  const modelID = spec.slice(separatorIndex + 1).trim();
  if (!providerID || !modelID) {
    throw new Error(`Invalid model spec: ${spec}`);
  }
  return { providerID, modelID };
}

async function disposeInstance(client, server, root) {
  try {
    await unwrap(
      client.instance.dispose({ query: { directory: root } }),
      "instance.dispose"
    );
  } catch (error) {
    logStep(`Instance dispose failed: ${formatError(error)}`);
  }
  server.close();
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    return false;
  }
}

function unwrap(result, label) {
  if (result && typeof result === "object" && "data" in result) {
    if (result.error) {
      throw new Error(`${label} failed: ${formatError(result.error)}`);
    }
    return result.data;
  }
  return result;
}

function extractSessionID(session, context) {
  if (!session || typeof session !== "object") {
    throw new Error(`${context} did not return a session object.`);
  }

  const candidates = [
    session.id,
    session.sessionID,
    session.info?.id,
    session.info?.sessionID,
    session.properties?.id,
    session.properties?.sessionID,
    session.properties?.info?.id,
    session.properties?.info?.sessionID,
    session.slug,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  throw new Error(
    `${context} returned a session without an id. Response: ${safeStringify(session)}`
  );
}

function safeStringify(value, maxLength = 1000) {
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string" && json.length > 0) {
      return json.length > maxLength ? `${json.slice(0, maxLength)}...` : json;
    }
  } catch (error) {
    // fall through to String()
  }
  return String(value);
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch (stringifyError) {
    return String(error);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(message) {
  console.log(`[orchestrator] ${message}`);
}

main().catch((error) => {
  console.error(`[orchestrator] Failed: ${formatError(error)}`);
  process.exitCode = 1;
});
