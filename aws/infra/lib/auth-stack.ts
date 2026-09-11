import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";

export interface AuthStackProps extends cdk.StackProps {
  envName: string;
}

/**
 * Cognito replaces Firebase Auth custom tokens. The `role` custom claim is
 * the direct replacement for the Firebase Admin SDK's `setCustomUserClaims`
 * (see firebase/functions/src/lib/authService.ts) — set via a
 * PreTokenGeneration Lambda trigger that reads `users.role` from Postgres so
 * the claim is always fresh even if the role changes after last login,
 * exactly like the Firestore users/{uid} listener did client-side.
 *
 * Staff never sign up themselves — accounts are created by an admin via the
 * `staffAdmin` API (AdminCreateUser), so self-registration is disabled.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const preTokenGen = new lambda.Function(this, "PreTokenGenFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "preTokenGeneration.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../backend/dist/triggers")),
      timeout: cdk.Duration.seconds(5),
      description: "Injects the current role custom claim from Postgres users.role at every token mint",
    });

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `nlpos-${props.envName}`,
      selfSignUpEnabled: false, // admin/staffAdmin API only — mirrors "no public signup" in the Firebase version
      signInAliases: { username: true, email: false },
      standardAttributes: { fullname: { required: false, mutable: true } },
      customAttributes: {
        role: new cognito.StringAttribute({ mutable: true }),
        pos_uid: new cognito.StringAttribute({ mutable: false }), // = users.uid, stable FK into Postgres
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.NONE, // staff resets are admin-driven (staffAdmin.resetPassword), not self-serve email/SMS
      lambdaTriggers: { preTokenGeneration: preTokenGen },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient("StaffAppClient", {
      authFlows: { userPassword: true, userSrp: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(14),
      preventUserExistenceErrors: true,
    });

    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
  }
}
