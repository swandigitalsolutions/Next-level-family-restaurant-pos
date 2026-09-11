import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as path from "path";

export interface AuthStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  dbSecretArn: string;
  dbProxyEndpoint: string;
  lambdaSg: ec2.SecurityGroup;
}

/**
 * Cognito replaces Firebase Auth custom tokens. The `role` custom claim is
 * the direct replacement for the Firebase Admin SDK's `setCustomUserClaims`
 * (see firebase/functions/src/lib/authService.ts) — set via a
 * PreTokenGeneration Lambda trigger that reads `users.role` from Postgres so
 * the claim is always fresh even if the role changes after last login,
 * exactly like the Firestore users/{uid} listener did client-side. This
 * Lambda needs the same VPC/DB wiring as every other backend handler — it
 * queries Postgres through RDS Proxy on every single token mint (login +
 * refresh), so it is on the hot path for every staff sign-in.
 *
 * Staff never sign up themselves — accounts are created by an admin via the
 * `staffAdmin` API (AdminCreateUser), so self-registration is disabled.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const backendRoot = path.join(__dirname, "../../backend");
    const dbSecret = secrets.Secret.fromSecretCompleteArn(this, "DbSecret", props.dbSecretArn);
    const preTokenGen = new nodejs.NodejsFunction(this, "PreTokenGenFn", {
      entry: path.join(backendRoot, "src/handlers/triggers/preTokenGeneration.ts"),
      projectRoot: backendRoot,
      depsLockFilePath: path.join(backendRoot, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: { DB_SECRET_ARN: props.dbSecretArn, DB_PROXY_ENDPOINT: props.dbProxyEndpoint, DB_NAME: "posdb" },
      bundling: { minify: true, sourceMap: true, target: "node20" },
      description: "Injects the current role custom claim from Postgres users.role at every token mint",
    });
    dbSecret.grantRead(preTokenGen);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `nlpos-${props.envName}`,
      selfSignUpEnabled: false, // admin/staffAdmin API only — mirrors "no public signup" in the Firebase version
      signInAliases: { username: true, email: false },
      standardAttributes: { fullname: { required: false, mutable: true } },
      customAttributes: {
        role: new cognito.StringAttribute({ mutable: true }),
        pos_uid: new cognito.StringAttribute({ mutable: true }), // set once right after AdminCreateUser (see cognitoAuth.ts) — CDK requires mutable:true to allow that first post-creation write
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.NONE, // staff resets are admin-driven (staffAdmin.updateStaff), not self-serve email/SMS
      lambdaTriggers: { preTokenGeneration: preTokenGen },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient("StaffAppClient", {
      authFlows: { userPassword: true, userSrp: true, adminUserPassword: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(14),
      preventUserExistenceErrors: true,
    });

    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
  }
}
