import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

/**
 * Minimal-cost VPC: 2 AZs, no NAT gateway (Lambda + RDS Proxy stay in private
 * isolated subnets and never need outbound internet — Secrets Manager/S3/etc.
 * reach them via VPC endpoints, added lazily if a handler needs one). This
 * avoids the ~$32/mo/NAT-gateway tax for a single-restaurant deployment.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Explicit AZs (rather than maxAzs, which needs a live account/region
    // lookup) so `cdk synth` is reproducible without real AWS credentials —
    // ap-south-1a/1b always exist. Override via context (-c azs=...) for a
    // different region.
    const azs = (this.node.tryGetContext("azs") as string[]) || [`${this.region}a`, `${this.region}b`];
    this.vpc = new ec2.Vpc(this, "Vpc", {
      availabilityZones: azs,
      natGateways: 0,
      subnetConfiguration: [
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Gateway endpoint (free) so handlers can still reach S3 without NAT.
    this.vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    this.vpc.addInterfaceEndpoint("SecretsManagerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });
    // Needed so isolated-subnet Lambdas can reach the WebSocket management
    // API (broadcastClient.ts / connect.ts's AdminInitiateAuth-adjacent
    // calls) and Cognito itself without a NAT gateway.
    this.vpc.addInterfaceEndpoint("ExecuteApiEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
    });
    this.vpc.addInterfaceEndpoint("CognitoIdpEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.COGNITO_IDP,
    });

    this.lambdaSg = new ec2.SecurityGroup(this, "LambdaSg", {
      vpc: this.vpc,
      description: "Lambda handlers (API + realtime) — egress only, no inbound",
      allowAllOutbound: true,
    });
  }
}
