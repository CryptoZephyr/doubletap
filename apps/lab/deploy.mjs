import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  Adapter,
  BuildRuntime,
  Client,
  Framework,
  Sites,
} from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';

const execFileAsync = promisify(execFile);
const endpoint = process.env.APPWRITE_ENDPOINT ?? 'https://fra.cloud.appwrite.io/v1';
const projectId = process.env.APPWRITE_PROJECT_ID ?? '6ae32d6f0034eb612a86';
const siteId = 'race-lab';
const root = import.meta.dirname;
const apiKey = requiredEnv('APPWRITE_API_KEY');
const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const sites = new Sites(client);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isFrameworkRejection(error) {
  const message = `${error?.type ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return [400, 422].includes(error?.code) && message.includes('framework') &&
    /(invalid|unsupported|unknown|not found|not available)/.test(message);
}

function isRuntimeRejection(error) {
  const message = `${error?.type ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return [400, 422].includes(error?.code) && /runtime/.test(message) &&
    /(invalid|unsupported|unknown|not found|not available)/.test(message);
}

function isScopeFailure(error) {
  return error?.code === 401 || error?.code === 403 ||
    /missing scopes/i.test(error?.message ?? '');
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function createOrUpdateSite(framework, buildRuntime) {
  const settings = {
    siteId,
    name: 'doubletap race lab',
    framework,
    buildRuntime,
    adapter: Adapter.Static,
    enabled: true,
    logging: true,
    installCommand: 'npm install',
    buildCommand: 'npm run build',
    outputDirectory: 'dist',
  };
  try {
    return await sites.create(settings);
  } catch (error) {
    if (error?.code !== 409) throw error;
    return await sites.update(settings);
  }
}

async function createSiteWithFrameworkFallback(buildRuntime) {
  try {
    return {
      site: await createOrUpdateSite(Framework.Vite, buildRuntime),
      framework: Framework.Vite,
    };
  } catch (error) {
    if (isScopeFailure(error) || !isFrameworkRejection(error)) throw error;
    console.log('Appwrite rejected the Vite framework, retrying with other');
    return {
      site: await createOrUpdateSite(Framework.Other, buildRuntime),
      framework: Framework.Other,
    };
  }
}

async function createSiteWithRuntimeFallback() {
  const runtimeCandidates = [BuildRuntime.Node22, BuildRuntime.Node210, BuildRuntime.Node200];
  for (const buildRuntime of runtimeCandidates) {
    try {
      return {
        ...(await createSiteWithFrameworkFallback(buildRuntime)),
        buildRuntime,
      };
    } catch (error) {
      if (isScopeFailure(error) || !isRuntimeRejection(error)) throw error;
      if (buildRuntime === runtimeCandidates.at(-1)) throw error;
      console.log(`${buildRuntime} rejected, trying the next build runtime`);
    }
  }
  throw new Error('Appwrite rejected build runtimes node-22, node-21.0, and node-20.0');
}

function siteUrlMetadata(site) {
  return Object.fromEntries(
    Object.entries(site).filter(([key]) => /url|domain/i.test(key)),
  );
}

async function main() {
  const { site } = await createSiteWithRuntimeFallback();
  console.log(`Configured site ${site.$id}: framework=${site.framework}, buildRuntime=${site.buildRuntime}`);

  const tempDirectory = await mkdtemp(join(tmpdir(), 'doubletap-race-lab-'));
  try {
    const archive = await createArchive(tempDirectory);
    const deployment = await deploy(archive);
    console.log(`Site URL metadata: ${JSON.stringify(siteUrlMetadata(site))}`);
    console.log(`Deployment ID: ${deployment.$id}`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function createArchive(tempDirectory) {
  const archive = resolve(tempDirectory, 'race-lab.tar.gz');
  await execFileAsync('tar', [
    '-czf',
    archive,
    '--exclude=node_modules',
    '--exclude=dist',
    '--exclude=*/node_modules',
    '--exclude=*/dist',
    '--exclude=deploy.mjs',
    '-C',
    root,
    '.',
  ]);
  const { stdout } = await execFileAsync('tar', ['-tzf', archive]);
  const excludedEntries = stdout
    .split('\n')
    .filter((entry) => entry.split('/').some((part) => part === 'node_modules' || part === 'dist'));
  if (excludedEntries.length > 0) {
    throw new Error(`Source archive contains excluded paths: ${excludedEntries.join(', ')}`);
  }
  return archive;
}

async function deploy(archive) {
  let current = await sites.createDeployment({
    siteId,
    code: InputFile.fromPath(archive),
    installCommand: 'npm install',
    buildCommand: 'npm run build',
    outputDirectory: 'dist',
    activate: true,
  });
  const deploymentId = current.$id;
  const deadline = Date.now() + 600_000;

  while (current.status !== 'ready') {
    if (current.status === 'failed' || current.status === 'canceled') {
      throw new Error(
        `Site deployment ${deploymentId} ${current.status}:\n${current.buildLogs || '(no build logs)'}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Site deployment ${deploymentId} timed out at ${current.status}:\n${current.buildLogs || '(no build logs)'}`,
      );
    }
    await sleep(2000);
    current = await sites.getDeployment({ siteId, deploymentId });
  }

  console.log(`Site deployment ${deploymentId} ready after ${current.buildDuration}s build`);
  return current;
}

main().catch((error) => {
  if (error?.code !== undefined || error?.type !== undefined) {
    console.error(
      `Appwrite error code=${error.code ?? 'unknown'} type=${error.type ?? 'unknown'}: ${error.message ?? error}`,
    );
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
