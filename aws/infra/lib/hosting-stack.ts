import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";

export interface HostingStackProps extends cdk.StackProps {
  envName: string;
  apiDomain: string;
  wsDomain: string;
}

/**
 * S3 + CloudFront replaces Firebase Hosting. Same cleanUrls behaviour is
 * reproduced via CloudFront Function (URL rewrite, `/pages/login` ->
 * `/pages/login.html`) instead of Firebase's built-in cleanUrls — the exact
 * bug class that caused the "login page flickering" incident on Firebase
 * must be re-verified here (see aws/docs/PARITY-CHECKLIST.md).
 */
export class HostingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HostingStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const cleanUrlsFn = new cf.Function(this, "CleanUrlsFn", {
      code: cf.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  // "/pages/login" (no extension, no trailing slash) -> "/pages/login.html"
  if (uri === "/" ) { request.uri = "/pages/login.html"; return request; }
  if (!uri.includes(".") && !uri.endsWith("/")) {
    request.uri = uri + ".html";
  }
  return request;
}`),
    });

    const distribution = new cf.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{ function: cleanUrlsFn, eventType: cf.FunctionEventType.VIEWER_REQUEST }],
        cachePolicy: cf.CachePolicy.CACHING_DISABLED, // matches firebase.json Cache-Control: no-cache on js/mjs/css/html
      },
      additionalBehaviors: {
        "assets/*": { origin: origins.S3BucketOrigin.withOriginAccessControl(bucket), cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED },
      },
      defaultRootObject: "pages/login.html",
    });

    new deploy.BucketDeployment(this, "DeploySite", {
      sources: [deploy.Source.asset(path.join(__dirname, "../../hosting"))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
    });

    new cdk.CfnOutput(this, "SiteUrl", { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "ApiDomainInUse", { value: props.apiDomain });
    new cdk.CfnOutput(this, "WsDomainInUse", { value: props.wsDomain });
  }
}
