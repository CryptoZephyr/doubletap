import { randomBytes } from 'node:crypto';
import { Client, ExecutionMethod, Functions, Query, TablesDB } from 'node-appwrite';

const endpoint = process.env.APPWRITE_ENDPOINT ?? 'https://fra.cloud.appwrite.io/v1';
const projectId = process.env.APPWRITE_PROJECT_ID ?? '6ae32d6f0034eb612a86';
const apiKey = process.env.APPWRITE_API_KEY;
const databaseId = process.env.APPWRITE_DATABASE_ID ?? 'doubletap';
const functionId = process.argv[2];
const count = 100;
const rounds = 3;

if (!apiKey) {
  console.error('APPWRITE_API_KEY is required');
  process.exit(2);
}

if (!functionId || !/^[A-Za-z0-9._-]{1,36}$/.test(functionId)) {
  console.error('Usage: node apps/pay/jobrace.mjs <function-id>');
  process.exit(2);
}

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);
const functions = new Functions(client);
const tablesDB = new TablesDB(client);

function countBy(items, keyOf) {
  return items.reduce((counts, item) => {
    const key = String(keyOf(item) ?? 'unknown');
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function formatCounts(counts) {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(', ') : 'none';
}

function errorCode(error) {
  return error?.type ?? error?.code ?? 'unknown';
}

async function countPhase(run, phase) {
  const result = await tablesDB.listRows({
    databaseId,
    tableId: 'trace',
    queries: [
      Query.equal('run', run),
      Query.equal('phase', phase),
      Query.limit(1),
    ],
  });
  return result.total;
}

async function runRound(round) {
  const id = randomBytes(8).toString('hex');
  const run = `jr_${id}`;
  const orderId = `job_${id}`;
  const body = { orderId, run, mode: 'job' };
  const startedAt = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, index) =>
      functions.createExecution({
        functionId,
        body: JSON.stringify({
          ...body,
          requestId: `q_${id}_${index.toString(36)}`,
        }),
        async: false,
        method: ExecutionMethod.POST,
      }),
    ),
  );
  const executionWallMs = Date.now() - startedAt;
  const executions = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const requestErrors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  const statuses = countBy(executions, (execution) => execution.status);
  for (const error of requestErrors) statuses['request-error'] = (statuses['request-error'] ?? 0) + 1;
  const responseCodes = countBy(
    executions.filter((execution) => execution.responseStatusCode !== undefined),
    (execution) => execution.responseStatusCode,
  );
  const failedExecutions = executions.filter((execution) => execution.status === 'failed').length;
  const failuresByCode = countBy(requestErrors, errorCode);
  const rateLimits = requestErrors.filter((error) => Number(error?.code) === 429).length +
    executions.filter((execution) => Number(execution.responseStatusCode) === 429).length;
  const [won, refused] = await Promise.all([
    countPhase(run, 'won'),
    countPhase(run, 'refused'),
  ]);

  console.log(
    `round ${round}/${rounds} function=${functionId} run=${run} orderId=${orderId} ` +
    `won=${won} refused=${refused} failedExecutions=${failedExecutions} ` +
    `statuses=[${formatCounts(statuses)}] responses=[${formatCounts(responseCodes)}] ` +
    `failures=[${formatCounts(failuresByCode)}] 429s=${rateLimits} executionWall=${executionWallMs}ms`,
  );
}

for (let round = 1; round <= rounds; round += 1) {
  await runRound(round);
}
