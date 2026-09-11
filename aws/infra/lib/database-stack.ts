import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";

export interface DatabaseStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

/**
 * Aurora PostgreSQL Serverless v2 (scales 0.5–2 ACU for a single-restaurant
 * workload; raise maxCapacity before a multi-branch rollout). RDS Proxy in
 * front absorbs Lambda's connection-per-invocation pattern. Automated
 * backups + PITR on by default (rds.DatabaseCluster backup.retention).
 * Deletion protection ON — an accidental `cdk destroy` cannot drop the DB.
 */
export class DatabaseStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly proxy: rds.DatabaseProxy;
  public readonly secret: cdk.aws_secretsmanager.ISecret;
  public readonly dbSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const dbSg = new ec2.SecurityGroup(this, "DbSg", { vpc: props.vpc, allowAllOutbound: false });
    this.dbSg = dbSg;

    this.cluster = new rds.DatabaseCluster(this, "Cluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_4 }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      writer: rds.ClusterInstance.serverlessV2("writer"),
      defaultDatabaseName: "posdb",
      storageEncrypted: true,
      backup: { retention: cdk.Duration.days(14) },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.secret = this.cluster.secret!;

    this.proxy = this.cluster.addProxy("Proxy", {
      secrets: [this.secret],
      vpc: props.vpc,
      securityGroups: [dbSg],
      requireTLS: true,
      iamAuth: false, // Secrets-Manager auth kept for parity with existing tooling; IAM auth is a easy hardening follow-up
    });

    // Lambda SGs get ingress in ApiStack/RealtimeStack via dbSg.addIngressRule
    // once those stacks' lambdaSg exists (cross-stack SG reference).
    new cdk.CfnOutput(this, "ProxyEndpoint", { value: this.proxy.endpoint });
    new cdk.CfnOutput(this, "SecretArn", { value: this.secret.secretArn });
  }
}
