import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as integ from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authz from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as path from "path";

export interface ApiStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  dbSecretArn: string;
  dbProxyEndpoint: string;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  lambdaSg: ec2.SecurityGroup;
}

/**
 * API Gateway HTTP API — replaces Firebase Hosting rewrites + Cloud Functions
 * v2 onCall/onRequest. Route -> Lambda mapping mirrors firebase.json 1:1
 * (see aws/docs/ROUTE-MAP.md). Cognito JWT authorizer replaces
 * `context.auth` from onCall; role checks still happen in handler code
 * (assertRole — defense in depth, never trust the frontend gate alone).
 */
export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const dbSecret = secrets.Secret.fromSecretCompleteArn(this, "DbSecret", props.dbSecretArn);

    const commonEnv = {
      DB_SECRET_ARN: props.dbSecretArn,
      DB_PROXY_ENDPOINT: props.dbProxyEndpoint,
      DB_NAME: "posdb",
      RESTAURANT_TZ: "Asia/Kolkata",
      NODE_OPTIONS: "--enable-source-maps",
    };

    const mkFn = (id: string, entry: string, extraEnv: Record<string, string> = {}) => {
      const fn = new nodejs.NodejsFunction(this, id, {
        entry: path.join(__dirname, `../../backend/src/handlers/${entry}`),
        runtime: lambda.Runtime.NODEJS_20_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(15),
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [props.lambdaSg],
        environment: { ...commonEnv, ...extraEnv },
        bundling: { minify: true, sourceMap: true, target: "node20" },
      });
      dbSecret.grantRead(fn);
      return fn;
    };

    const authorizer = new authz.HttpUserPoolAuthorizer("CognitoAuthorizer", props.userPool, {
      userPoolClients: [props.userPoolClient],
    });

    this.httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: `nlpos-${props.envName}`,
      corsPreflight: {
        allowOrigins: ["*"], // tightened to the deployed hosting origin at deploy time via context
        allowMethods: [apigw.CorsHttpMethod.ANY],
        allowHeaders: ["*"],
      },
    });

    // ── Staff app: authenticated callable-style routes (Cognito JWT required) ──
    const callables: Array<[string, string]> = [
      ["loginWithPassword", "callable/loginWithPassword.ts"], // exchanges legacy hash OR issues Cognito challenge during cutover window
      ["staffAdmin", "callable/staffAdmin.ts"],
      ["catalogAdmin", "callable/catalogAdmin.ts"],
      ["tablesAdmin", "callable/tablesAdmin.ts"],
      ["billing", "callable/billing.ts"],
      ["kitchen", "callable/kitchen.ts"],
      ["qrOrdersAdmin", "callable/qrOrdersAdmin.ts"],
      ["websiteOrdersAdmin", "callable/websiteOrdersAdmin.ts"],
    ];
    for (const [routeId, entry] of callables) {
      const fn = mkFn(routeId, entry);
      this.httpApi.addRoutes({
        path: `/api/callable/${routeId}`,
        methods: [apigw.HttpMethod.POST],
        integration: new integ.HttpLambdaIntegration(`${routeId}Integ`, fn),
        authorizer: routeId === "loginWithPassword" ? undefined : authorizer,
      });
    }

    // ── Public HTTP endpoints (no Cognito token — mirror firebase.json rewrites) ──
    const websiteApiKeySecret = secrets.Secret.fromSecretNameV2(this, "WebsiteApiKeySecret", `nlpos-${props.envName}/website-api-key`);
    const razorpaySecret = secrets.Secret.fromSecretNameV2(this, "RazorpaySecret", `nlpos-${props.envName}/razorpay`);

    const websiteApi = mkFn("websiteApi", "http/websiteApi.ts");
    websiteApiKeySecret.grantRead(websiteApi);
    razorpaySecret.grantRead(websiteApi);
    this.httpApi.addRoutes({
      path: "/api/website/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration: new integ.HttpLambdaIntegration("WebsiteApiInteg", websiteApi),
    });

    const razorpayWebhook = mkFn("razorpayWebhook", "http/paymentWebhook.ts");
    razorpaySecret.grantRead(razorpayWebhook);
    this.httpApi.addRoutes({
      path: "/api/razorpay/webhook",
      methods: [apigw.HttpMethod.POST],
      integration: new integ.HttpLambdaIntegration("RazorpayWebhookInteg", razorpayWebhook),
    });

    const qrApi = mkFn("qrApi", "http/qrApi.ts");
    this.httpApi.addRoutes({
      path: "/api/qr/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration: new integ.HttpLambdaIntegration("QrApiInteg", qrApi),
    });

    const websiteMenu = mkFn("websiteMenu", "http/websiteMenu.ts");
    this.httpApi.addRoutes({
      path: "/api/website/menu",
      methods: [apigw.HttpMethod.GET],
      integration: new integ.HttpLambdaIntegration("WebsiteMenuInteg", websiteMenu),
    });

    const exportReport = mkFn("exportReport", "http/exportReport.ts", {});
    this.httpApi.addRoutes({
      path: "/api/reports/export",
      methods: [apigw.HttpMethod.GET],
      integration: new integ.HttpLambdaIntegration("ExportReportInteg", exportReport),
      authorizer,
    });

    new cdk.CfnOutput(this, "ApiEndpoint", { value: this.httpApi.apiEndpoint });
  }
}
