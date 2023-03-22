/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

/* istanbul ignore file */

import { PluginHost } from 'aws-cdk/lib/api/plugin';
import { RequireApproval } from 'aws-cdk/lib/diff';
import { Command } from 'aws-cdk/lib/settings';
import * as AWS from 'aws-sdk';
import * as fs from 'fs';

import { AccountsConfig, GlobalConfig } from '@aws-accelerator/config';
import { createLogger, throttlingBackOff } from '@aws-accelerator/utils';
import { AssumeProfilePlugin } from '@aws-cdk-extensions/cdk-plugin-assume-role';

import { AcceleratorStage } from './accelerator-stage';
import { AcceleratorToolkit } from './toolkit';

const logger = createLogger(['accelerator']);

process.on('uncaughtException', err => {
  logger.error(err);
  throw new Error('Synthesis failed');
});

/**
 * List of AWS ELB root account and regions mapping
 */
export const AcceleratorElbRootAccounts: Record<string, string> = {
  'us-east-1': '127311923021',
  'us-east-2': '033677994240',
  'us-west-1': '027434742980',
  'us-west-2': '797873946194',
  'af-south-1': '098369216593',
  'ca-central-1': '985666609251',
  'eu-central-1': '054676820928',
  'eu-west-1': '156460612806',
  'eu-west-2': '652711504416',
  'eu-south-1': '635631232127',
  'eu-west-3': '009996457667',
  'eu-north-1': '897822967062',
};

export const OptInRegions = [
  'af-south-1',
  'ap-east-1',
  'ap-south-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'eu-central-2',
  'eu-south-1',
  'eu-south-2',
  'me-central-1',
  'me-south-1',
];

/**
 * constant maintaining cloudformation stack names
 */
export const AcceleratorStackNames: Record<string, string> = {
  [AcceleratorStage.PREPARE]: 'AWSAccelerator-PrepareStack',
  [AcceleratorStage.PIPELINE]: 'AWSAccelerator-PipelineStack',
  [AcceleratorStage.TESTER_PIPELINE]: 'AWSAccelerator-TesterPipelineStack',
  [AcceleratorStage.ORGANIZATIONS]: 'AWSAccelerator-OrganizationsStack',
  [AcceleratorStage.KEY]: 'AWSAccelerator-KeyStack',
  [AcceleratorStage.LOGGING]: 'AWSAccelerator-LoggingStack',
  [AcceleratorStage.BOOTSTRAP]: 'AWSAccelerator-BootstrapStack',
  [AcceleratorStage.ACCOUNTS]: 'AWSAccelerator-AccountsStack',
  [AcceleratorStage.DEPENDENCIES]: 'AWSAccelerator-DependenciesStack',
  [AcceleratorStage.SECURITY]: 'AWSAccelerator-SecurityStack',
  [AcceleratorStage.SECURITY_RESOURCES]: 'AWSAccelerator-SecurityResourcesStack',
  [AcceleratorStage.OPERATIONS]: 'AWSAccelerator-OperationsStack',
  [AcceleratorStage.NETWORK_PREP]: 'AWSAccelerator-NetworkPrepStack',
  [AcceleratorStage.NETWORK_VPC]: 'AWSAccelerator-NetworkVpcStack',
  [AcceleratorStage.NETWORK_VPC_ENDPOINTS]: 'AWSAccelerator-NetworkVpcEndpointsStack',
  [AcceleratorStage.NETWORK_VPC_DNS]: 'AWSAccelerator-NetworkVpcDnsStack',
  [AcceleratorStage.NETWORK_ASSOCIATIONS]: 'AWSAccelerator-NetworkAssociationsStack',
  [AcceleratorStage.NETWORK_ASSOCIATIONS_GWLB]: 'AWSAccelerator-NetworkAssociationsGwlbStack',
  [AcceleratorStage.FINALIZE]: 'AWSAccelerator-FinalizeStack',
  [AcceleratorStage.SECURITY_AUDIT]: 'AWSAccelerator-SecurityAuditStack',
  [AcceleratorStage.CUSTOMIZATIONS]: 'AWSAccelerator-CustomizationsStack',
};

/**
 *
 */
export interface AcceleratorProps {
  readonly command: string;
  readonly configDirPath: string;
  readonly stage?: string;
  readonly account?: string;
  readonly region?: string;
  readonly partition: string;
  readonly requireApproval: RequireApproval;
  readonly app?: string;
  readonly caBundlePath?: string;
  readonly ec2Creds?: boolean;
  readonly proxyAddress?: string;
}

/**
 * Wrapper around the CdkToolkit. The Accelerator defines this wrapper to add
 * the following functionality:
 *
 * - x
 * - y
 * - z
 */
export abstract class Accelerator {
  // private static readonly DEFAULT_MAX_CONCURRENT_STACKS = 20;

  static isSupportedStage(stage: AcceleratorStage): boolean {
    if (stage === undefined) {
      return false;
    }
    return Object.values(AcceleratorStage).includes(stage);
  }

  /**
   *
   * @returns
   */
  static async run(props: AcceleratorProps): Promise<void> {
    let managementAccountCredentials = undefined;
    let globalConfig = undefined;
    let assumeRolePlugin = undefined;

    let globalRegion = 'us-east-1';

    if (props.partition === 'aws-us-gov') {
      globalRegion = 'us-gov-west-1';
    } else if (props.partition === 'aws-iso-b') {
      globalRegion = 'us-isob-east-1';
    } else if (props.partition === 'aws-iso') {
      globalRegion = 'us-iso-east-1';
    } else if (props.partition === 'aws-cn') {
      globalRegion = 'cn-northwest-1';
    }

    if (props.stage !== AcceleratorStage.PIPELINE && props.stage !== AcceleratorStage.TESTER_PIPELINE) {
      // Get management account credential when pipeline is executing outside of management account
      managementAccountCredentials = await this.getManagementAccountCredentials(props.partition);

      // Load in the global config to read in the management account access roles
      globalConfig = GlobalConfig.load(props.configDirPath);

      //
      // Load Plugins
      //
      assumeRolePlugin = new AssumeProfilePlugin({
        region: props.region ?? globalRegion,
        assumeRoleName: globalConfig.managementAccountAccessRole,
        assumeRoleDuration: 3600,
        credentials: managementAccountCredentials,
        partition: props.partition,
        caBundlePath: props.caBundlePath,
      });
      assumeRolePlugin.init(PluginHost.instance);
    }

    //
    // When an account and region is specified, execute as single stack
    //
    if (props.account || props.region) {
      if (props.account && props.region === undefined) {
        logger.error(`Account set to ${props.account}, but region is undefined`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
      if (props.region && props.account === undefined) {
        logger.error(`Region set to ${props.region}, but account is undefined`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      return AcceleratorToolkit.execute({
        command: props.command,
        accountId: props.account,
        region: props.region,
        partition: props.partition,
        stage: props.stage,
        configDirPath: props.configDirPath,
        requireApproval: props.requireApproval,
        app: props.app,
        caBundlePath: props.caBundlePath,
        ec2Creds: props.ec2Creds,
        proxyAddress: props.proxyAddress,
      });
    }

    // Treat synthesize as a single - do not need parallel paths to generate all stacks
    if (props.command === Command.SYNTH || props.command === Command.SYNTHESIZE || props.command === Command.DIFF) {
      return AcceleratorToolkit.execute({
        command: props.command,
        accountId: props.account,
        region: props.region,
        partition: props.partition,
        stage: props.stage,
        configDirPath: props.configDirPath,
        requireApproval: props.requireApproval,
        app: props.app,
        caBundlePath: props.caBundlePath,
        ec2Creds: props.ec2Creds,
        proxyAddress: props.proxyAddress,
      });
    }

    //
    // Read in all Accelerator Configuration files here, then pass the objects
    // to the stacks that need them. Exceptions are thrown if any of the
    // configuration files are malformed.
    //
    globalConfig = GlobalConfig.load(props.configDirPath);
    const accountsConfig = AccountsConfig.load(props.configDirPath);

    //
    // Will load in account IDs using the Organizations client if not provided
    // as inputs in accountsConfig
    //
    await accountsConfig.loadAccountIds(props.partition);

    //
    // When running parallel, this will be the max concurrent stacks
    //
    const maxStacks = process.env['MAX_CONCURRENT_STACKS'] ?? 500;

    const promises: Promise<void>[] = [];

    //
    // Execute Bootstrap stacks for all identified accounts
    //
    if (props.command == 'bootstrap') {
      const trustedAccountId = accountsConfig.getManagementAccountId();
      for (const region of globalConfig.enabledRegions) {
        for (const account of [...accountsConfig.mandatoryAccounts, ...accountsConfig.workloadAccounts]) {
          promises.push(
            AcceleratorToolkit.execute({
              command: props.command,
              accountId: accountsConfig.getAccountId(account.name),
              region,
              partition: props.partition,
              trustedAccountId,
              configDirPath: props.configDirPath,
              requireApproval: props.requireApproval,
              app: props.app,
              caBundlePath: props.caBundlePath,
              ec2Creds: props.ec2Creds,
              proxyAddress: props.proxyAddress,
              centralizeCdkBootstrap: globalConfig?.centralizeCdkBuckets?.enable,
            }),
          );

          //override to prevent errors
          if (promises.length >= 100) {
            await Promise.all(promises);
          }
        }
      }
      await Promise.all(promises);
      return;
    }

    // Control Tower: To start a well-planned OU structure in your landing zone, AWS Control Tower
    // sets up a Security OU for you. This OU contains three shared accounts: the management
    // (primary) account, the log archive account, and the security audit account (also referred to
    // as the audit account).
    if (props.stage === AcceleratorStage.ACCOUNTS) {
      logger.info(`Executing ${props.stage} for Management account.`);
      return AcceleratorToolkit.execute({
        command: props.command,
        accountId: accountsConfig.getManagementAccountId(),
        region: globalRegion,
        partition: props.partition,
        stage: props.stage,
        configDirPath: props.configDirPath,
        requireApproval: props.requireApproval,
        app: props.app,
        caBundlePath: props.caBundlePath,
        ec2Creds: props.ec2Creds,
        proxyAddress: props.proxyAddress,
      });
    }

    if (props.stage === AcceleratorStage.PREPARE) {
      logger.info(`Executing ${props.stage} for Management account.`);
      return AcceleratorToolkit.execute({
        command: props.command,
        accountId: accountsConfig.getManagementAccountId(),
        region: globalConfig.homeRegion,
        partition: props.partition,
        stage: props.stage,
        configDirPath: props.configDirPath,
        requireApproval: props.requireApproval,
        app: props.app,
        caBundlePath: props.caBundlePath,
        ec2Creds: props.ec2Creds,
        proxyAddress: props.proxyAddress,
      });
    }

    if (props.stage === AcceleratorStage.FINALIZE) {
      logger.info(`Executing ${props.stage} for Management account.`);
      return AcceleratorToolkit.execute({
        command: props.command,
        accountId: accountsConfig.getManagementAccountId(),
        region: globalRegion,
        partition: props.partition,
        stage: props.stage,
        configDirPath: props.configDirPath,
        requireApproval: props.requireApproval,
        app: props.app,
      });
    }

    if (props.stage === AcceleratorStage.ORGANIZATIONS) {
      for (const region of globalConfig.enabledRegions) {
        logger.info(`Executing ${props.stage} for Management account in ${region} region.`);
        await delay(1000);
        promises.push(
          AcceleratorToolkit.execute({
            command: props.command,
            accountId: accountsConfig.getManagementAccountId(),
            region: region,
            partition: props.partition,
            stage: props.stage,
            configDirPath: props.configDirPath,
            requireApproval: props.requireApproval,
            app: props.app,
            caBundlePath: props.caBundlePath,
            ec2Creds: props.ec2Creds,
            proxyAddress: props.proxyAddress,
          }),
        );
        if (promises.length >= maxStacks) {
          await Promise.all(promises);
        }
      }
    }

    if (props.stage === AcceleratorStage.KEY || props.stage === AcceleratorStage.SECURITY_AUDIT) {
      for (const region of globalConfig.enabledRegions) {
        logger.info(`Executing ${props.stage} for audit account in ${region} region.`);
        await delay(1000);
        promises.push(
          AcceleratorToolkit.execute({
            command: props.command,
            accountId: accountsConfig.getAuditAccountId(),
            region: region,
            partition: props.partition,
            stage: props.stage,
            configDirPath: props.configDirPath,
            requireApproval: props.requireApproval,
            app: props.app,
            caBundlePath: props.caBundlePath,
            ec2Creds: props.ec2Creds,
            proxyAddress: props.proxyAddress,
          }),
        );
        if (promises.length >= maxStacks) {
          await Promise.all(promises);
        }
      }
    }

    //
    // CentralLogs bucket region logging stack needs to complete first before other enable regions. Because CentralLog buckets is created in home region.
    // ELB access log bucket is created in every region, ELB access log bucket needs to replicate to Central Log bucket, so CentralLogs bucket region must be completed
    // before any other region.
    // When CentralLogs bucket is not defined, CentralLogs bucket will be pipeline home region.
    if (props.stage === AcceleratorStage.LOGGING) {
      const logAccountId = accountsConfig.getLogArchiveAccountId();
      const logAccountName = accountsConfig.getAccountId(accountsConfig.getLogArchiveAccount().name);
      const centralLogsBucketRegion = globalConfig.logging.centralizedLoggingRegion ?? globalConfig.homeRegion;

      // Execute home region before other region for LogArchive account
      logger.info(`Executing ${props.stage} for ${logAccountName} account in ${centralLogsBucketRegion} region.`);
      await AcceleratorToolkit.execute({
        command: props.command,
        accountId: logAccountId,
        region: centralLogsBucketRegion,
        partition: props.partition,
        stage: props.stage,
        configDirPath: props.configDirPath,
        requireApproval: props.requireApproval,
        app: props.app,
      });
      // execute in all other regions for Logging account, except home region
      for (const region of globalConfig.enabledRegions) {
        if (region !== centralLogsBucketRegion) {
          logger.info(`Executing ${props.stage} for ${logAccountName} account in ${region} region.`);
          await AcceleratorToolkit.execute({
            command: props.command,
            accountId: logAccountId,
            region: region,
            partition: props.partition,
            stage: props.stage,
            configDirPath: props.configDirPath,
            requireApproval: props.requireApproval,
            app: props.app,
          });
        }
      }
      // execute in all other regions for all accounts, except logging account home region
      for (const region of globalConfig.enabledRegions) {
        for (const account of [...accountsConfig.mandatoryAccounts, ...accountsConfig.workloadAccounts]) {
          logger.info(`Executing ${props.stage} for ${account.name} account in ${region} region.`);
          const accountId = accountsConfig.getAccountId(account.name);
          await delay(1000);
          if (accountId !== logAccountId) {
            promises.push(
              AcceleratorToolkit.execute({
                command: props.command,
                accountId,
                region,
                partition: props.partition,
                stage: props.stage,
                configDirPath: props.configDirPath,
                requireApproval: props.requireApproval,
                app: props.app,
              }),
            );
          }

          if (promises.length >= maxStacks) {
            await Promise.all(promises);
          }
        }
      }
    }

    if (
      props.stage === AcceleratorStage.SECURITY ||
      props.stage === AcceleratorStage.SECURITY_RESOURCES ||
      props.stage === AcceleratorStage.OPERATIONS ||
      props.stage === AcceleratorStage.NETWORK_PREP ||
      props.stage === AcceleratorStage.NETWORK_VPC ||
      props.stage === AcceleratorStage.NETWORK_ASSOCIATIONS ||
      props.stage === AcceleratorStage.CUSTOMIZATIONS
    ) {
      for (const region of globalConfig.enabledRegions) {
        for (const account of [...accountsConfig.mandatoryAccounts, ...accountsConfig.workloadAccounts]) {
          logger.info(`Executing ${props.stage} for ${account.name} account in ${region} region.`);
          await delay(1000);
          promises.push(
            AcceleratorToolkit.execute({
              command: props.command,
              accountId: accountsConfig.getAccountId(account.name),
              region,
              partition: props.partition,
              stage: props.stage,
              configDirPath: props.configDirPath,
              requireApproval: props.requireApproval,
              app: props.app,
              caBundlePath: props.caBundlePath,
              ec2Creds: props.ec2Creds,
              proxyAddress: props.proxyAddress,
            }),
          );
          if (promises.length >= maxStacks) {
            await Promise.all(promises);
          }
        }
      }
    }

    await Promise.all(promises);
  }

  static async getManagementAccountCredentials(partition: string): Promise<AWS.STS.Credentials | undefined> {
    if (process.env['CREDENTIALS_PATH'] && fs.existsSync(process.env['CREDENTIALS_PATH'])) {
      logger.info('Detected Debugging environment. Loading temporary credentials.');

      const credentialsString = fs.readFileSync(process.env['CREDENTIALS_PATH']).toString();
      const credentials = JSON.parse(credentialsString);

      // Support for V2 SDK
      AWS.config.update({
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      });
    }
    if (
      process.env['MANAGEMENT_ACCOUNT_ID'] &&
      process.env['MANAGEMENT_ACCOUNT_ROLE_NAME'] &&
      process.env['ACCOUNT_ID'] !== process.env['MANAGEMENT_ACCOUNT_ID']
    ) {
      logger.info('set management account credentials');
      logger.info(`managementAccountId => ${process.env['MANAGEMENT_ACCOUNT_ID']}`);
      logger.info(`management account role name => ${process.env['MANAGEMENT_ACCOUNT_ROLE_NAME']}`);

      const roleArn = `arn:${partition}:iam::${process.env['MANAGEMENT_ACCOUNT_ID']}:role/${process.env['MANAGEMENT_ACCOUNT_ROLE_NAME']}`;
      const stsClient = new AWS.STS({ region: process.env['AWS_REGION'] });
      logger.info(`management account roleArn => ${roleArn}`);

      const assumeRoleCredential = await throttlingBackOff(() =>
        stsClient.assumeRole({ RoleArn: roleArn, RoleSessionName: 'acceleratorAssumeRoleSession' }).promise(),
      );

      process.env['AWS_ACCESS_KEY_ID'] = assumeRoleCredential.Credentials!.AccessKeyId!;
      process.env['AWS_ACCESS_KEY'] = assumeRoleCredential.Credentials!.AccessKeyId!;
      process.env['AWS_SECRET_KEY'] = assumeRoleCredential.Credentials!.SecretAccessKey!;
      process.env['AWS_SECRET_ACCESS_KEY'] = assumeRoleCredential.Credentials!.SecretAccessKey!;
      process.env['AWS_SESSION_TOKEN'] = assumeRoleCredential.Credentials!.SessionToken;

      // Support for V2 SDK
      AWS.config.update({
        accessKeyId: assumeRoleCredential.Credentials!.AccessKeyId,
        secretAccessKey: assumeRoleCredential.Credentials!.SecretAccessKey,
        sessionToken: assumeRoleCredential.Credentials!.SessionToken,
      });

      return assumeRoleCredential.Credentials;
    } else {
      return undefined;
    }
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
