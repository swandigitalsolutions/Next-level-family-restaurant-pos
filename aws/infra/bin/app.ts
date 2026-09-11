#!/usr/bin/env node
/**
 * CDK app entrypoint. Deploys nothing by itself — `cdk deploy` (or
 * `--all`) is a deliberate, out-of-band step (see aws/docs/DEPLOY.md).
 * Three environments are expected: dev / staging / production, selected via
 * `-c env=staging` (defaults to dev). Firebase stays live and untouched
 * throughout — this stack is built and proven independently.
 */
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";
import { DatabaseStack } from "../lib/database-stack";
import { AuthStack } from "../lib/auth-stack";
import { ApiStack } from "../lib/api-stack";
import { RealtimeStack } from "../lib/realtime-stack";
import { HostingStack } from "../lib/hosting-stack";

const app = new cdk.App();
const envName = (app.node.tryGetContext("env") as string) || "dev";
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION || "ap-south-1"; // Mumbai, matches Firebase asia-south1

const env = { account, region };
const tags = { Project: "nextlevel-pos", Environment: envName };
const prefix = `nlpos-${envName}`;

const network = new NetworkStack(app, `${prefix}-network`, { env, tags });

const database = new DatabaseStack(app, `${prefix}-database`, {
  env, tags, vpc: network.vpc,
});

const auth = new AuthStack(app, `${prefix}-auth`, { env, tags, envName });

const api = new ApiStack(app, `${prefix}-api`, {
  env, tags, envName,
  vpc: network.vpc,
  dbSecretArn: database.secret.secretArn,
  dbProxyEndpoint: database.proxy.endpoint,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  lambdaSg: network.lambdaSg,
});

const realtime = new RealtimeStack(app, `${prefix}-realtime`, {
  env, tags, envName,
  vpc: network.vpc,
  dbSecretArn: database.secret.secretArn,
  dbProxyEndpoint: database.proxy.endpoint,
  lambdaSg: network.lambdaSg,
  userPool: auth.userPool,
});

new HostingStack(app, `${prefix}-hosting`, {
  env, tags, envName,
  apiDomain: api.httpApi.apiEndpoint,
  wsDomain: realtime.webSocketApi.apiEndpoint,
});
