import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as integ from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";

export interface RealtimeStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  dbSecretArn: string;
  dbProxyEndpoint: string;
  lambdaSg: ec2.SecurityGroup;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
}

/**
 * Replaces Firestore onSnapshot (kitchen tickets, live QR/website order
 * boards) — the one piece of the app with NO direct AWS managed-service
 * equivalent that fits this stack's auth model as cleanly as AppSync would
 * for a fresh build. API Gateway WebSocket API chosen over AppSync because
 * it reuses the same Cognito user pool + Lambda handler pattern as the REST
 * API instead of introducing a second GraphQL authorization model; ws
 * connections are tracked in `ws_connections` (see db schema) and a
 * `$default` broadcaster Lambda is invoked by the write-path handlers
 * (kitchen.ts, qrOrdersAdmin.ts, websiteOrdersAdmin.ts) after every
 * status-changing commit — same pattern as Firestore's document-write trigger,
 * just invoked explicitly instead of via a DB-level trigger.
 *
 * Reconnect/dedup: the client resumes with `?since=<ISO ts>` on connect; the
 * $connect handler replays any tickets/orders updated after that timestamp
 * before live pushes start — the AWS analogue of the Firestore
 * `metadata.fromCache` + `kf_kds_seen_ms` dedup already implemented
 * client-side (frontend/js/common.js kitchenAlertDecision).
 */
export class RealtimeStack extends cdk.Stack {
  public readonly webSocketApi: apigw.WebSocketApi;
  public readonly callbackUrl: string;
  public readonly managementArn: string;

  constructor(scope: Construct, id: string, props: RealtimeStackProps) {
    super(scope, id, props);

    const commonEnv = {
      DB_SECRET_ARN: props.dbSecretArn,
      DB_PROXY_ENDPOINT: props.dbProxyEndpoint,
      DB_NAME: "posdb",
    };
    const dbSecret = secrets.Secret.fromSecretCompleteArn(this, "DbSecret", props.dbSecretArn);
    const backendRoot = path.join(__dirname, "../../backend");

    const mkFn = (id: string, entry: string) => {
      const fn = new nodejs.NodejsFunction(this, id, {
        entry: path.join(backendRoot, `src/handlers/realtime/${entry}`),
        projectRoot: backendRoot,
        depsLockFilePath: path.join(backendRoot, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_20_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [props.lambdaSg],
        environment: commonEnv,
        bundling: { minify: true, sourceMap: true, target: "node20" },
      });
      dbSecret.grantRead(fn);
      return fn;
    };

    const connectFn = mkFn("WsConnect", "connect.ts");
    connectFn.addEnvironment("COGNITO_USER_POOL_ID", props.userPool.userPoolId);
    connectFn.addEnvironment("COGNITO_CLIENT_ID", props.userPoolClient.userPoolClientId);
    const disconnectFn = mkFn("WsDisconnect", "disconnect.ts");
    const defaultFn = mkFn("WsDefault", "default.ts"); // keepalive / no-op

    this.webSocketApi = new apigw.WebSocketApi(this, "WebSocketApi", {
      apiName: `nlpos-${props.envName}-realtime`,
      connectRouteOptions: { integration: new integ.WebSocketLambdaIntegration("ConnectInteg", connectFn) },
      disconnectRouteOptions: { integration: new integ.WebSocketLambdaIntegration("DisconnectInteg", disconnectFn) },
      defaultRouteOptions: { integration: new integ.WebSocketLambdaIntegration("DefaultInteg", defaultFn) },
    });
    const stage = new apigw.WebSocketStage(this, "Stage", {
      webSocketApi: this.webSocketApi,
      stageName: props.envName,
      autoDeploy: true,
    });

    // No separate broadcaster Lambda: the write-path callables (kitchen.ts,
    // qrOrdersAdmin.ts, websiteOrdersAdmin.ts) call ApiGatewayManagementApi
    // directly (see lib/broadcastClient.ts) — simpler than a second hop
    // through an invoked Lambda, at the cost of granting those functions
    // `execute-api:ManageConnections` too (done in ApiStack via the
    // `callbackUrl`/`managementArn` this stack exposes).
    this.callbackUrl = stage.callbackUrl;
    this.managementArn = `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.apiId}/${props.envName}/POST/@connections/*`;

    new cdk.CfnOutput(this, "WebSocketEndpoint", { value: stage.url });
  }
}
