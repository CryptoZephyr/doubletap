import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import {
  Client,
  Functions,
  ProjectKeyScopes,
  Role,
  Runtime,
} from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';

const execFileAsync = promisify(execFile);
const endpoint = process.env.APPWRITE_ENDPOINT ?? 'https://fra.cloud.appwrite.io/v1';
const projectId = process.env.APPWRITE_PROJECT_ID ?? '6ae32d6f0034eb612a86';
const apiKey = requiredEnv('APPWRITE_API_KEY');
const root = import.meta.dirname;
const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const functions = new Functions(client);
const runtimeCandidates = [Runtime.Node22, Runtime.Node210, Runtime.Node200];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isNotFound(error) {
  return error?.code === 404;
}

function isRuntimeRejection(error) {
  const message = `${error?.type ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return error?.code !== 401 && error?.code !== 403 &&
    /runtime/.test(message) &&
    /(invalid|unsupported|unknown|unavailable|not found|not available|does not exist)/.test(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function getFunction(functionId) {
  try {
    return await functions.get({ functionId });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function configureFunction(functionId, name, runtime) {
  const current = await getFunction(functionId);
  const base = {
    functionId,
    name,
    execute: [Role.any()],
    timeout: 60,
    enabled: true,
    logging: true,
    entrypoint: 'index.mjs',
    scopes: [ProjectKeyScopes.RowsRead, ProjectKeyScopes.RowsWrite],
  };

  if (current) {
    await functions.update({ ...base, runtime });
  } else {
    await functions.create({ ...base, runtime });
  }
  console.log(`${functionId}: configured with ${runtime}`);
}

async function createArchive(functionId) {
  const directory = resolve(root, 'dist', functionId);
  const archive = resolve(root, 'dist', `${functionId}.tar.gz`);
  await mkdir(dirname(archive), { recursive: true });
  await execFileAsync('tar', ['-czf', archive, '-C', directory, 'index.mjs']);
  return archive;
}

async function deployWithRuntime(functionId) {
  const archive = await createArchive(functionId);
  const deployment = await functions.createDeployment({
    functionId,
    code: InputFile.fromPath(archive),
    activate: true,
    entrypoint: 'index.mjs',
  });
  const deadline = Date.now() + 300_000;
  let current = deployment;

  while (current.status !== 'ready') {
    if (current.status === 'failed' || current.status === 'canceled') {
      throw new Error(
        `${functionId} deployment ${current.status}:\n${current.buildLogs || '(no build logs)'}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${functionId} deployment timed out at ${current.status}:\n${current.buildLogs || '(no build logs)'}`,
      );
    }
    await sleep(2000);
    current = await functions.getDeployment({
      functionId,
      deploymentId: deployment.$id,
    });
  }

  console.log(`${functionId}: deployment ${current.$id} ready on ${current.buildDuration}s build`);
}

await import('./build.mjs');
const configured = [];
for (const [functionId, name] of [
  ['pay-naive', 'Pay Naive'],
  ['pay-doubletap', 'Pay Doubletap'],
]) {
  let deployedRuntime;
  for (const runtime of runtimeCandidates) {
    try {
      await configureFunction(functionId, name, runtime);
      await deployWithRuntime(functionId);
      deployedRuntime = runtime;
      break;
    } catch (error) {
      if (!isRuntimeRejection(error) || runtime === runtimeCandidates.at(-1)) throw error;
      console.log(`${functionId}: ${runtime} rejected, trying the next runtime`);
    }
  }
  if (!deployedRuntime) {
    throw new Error(`${functionId}: Appwrite rejected node-22, node-21.0, and node-20.0`);
  }
  configured.push([functionId, deployedRuntime]);
}
console.log(`Deployed functions: ${configured.map(([id, runtime]) => `${id}=${runtime}`).join(', ')}`);
