export interface ServiceVersionTransactionOptions {
	targetVersion?: string;
	previousVersion?: string;
	apply(version: string | undefined): Promise<void>;
	commit(version: string | undefined): void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface ServiceVersionTransactionResult {
	serviceVersion?: string;
	recovered?: {
		targetVersion: string;
		serviceVersion: string;
		reason: string;
	};
}

export async function runServiceVersionTransaction(
	options: ServiceVersionTransactionOptions,
): Promise<ServiceVersionTransactionResult> {
	try {
		await options.apply(options.targetVersion);
		options.commit(options.targetVersion);
		return options.targetVersion ? { serviceVersion: options.targetVersion } : {};
	} catch (error) {
		if (!options.targetVersion || !options.previousVersion || options.targetVersion === options.previousVersion) {
			throw error;
		}
		try {
			await options.apply(options.previousVersion);
			options.commit(options.previousVersion);
		} catch (recoveryError) {
			throw Object.assign(
				new Error(
					`Web 服务版本 ${options.targetVersion} 启动失败，服务版本 ${options.previousVersion} 恢复失败。LYStar Code 应用版本保持不变。新服务错误：${errorMessage(error)}；恢复错误：${errorMessage(recoveryError)}`,
				),
				{ code: "web_service_recovery_failed" },
			);
		}
		return {
			serviceVersion: options.previousVersion,
			recovered: {
				targetVersion: options.targetVersion,
				serviceVersion: options.previousVersion,
				reason: errorMessage(error),
			},
		};
	}
}
