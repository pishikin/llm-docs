class V2Error extends Error {
  details?: unknown;

  constructor(name: string, message: string, details?: unknown) {
    super(message);
    this.name = name;
    this.details = details;
  }
}

export class ConfigMigrationError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('ConfigMigrationError', message, details);
  }
}

export class WorkspaceBootstrapError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('WorkspaceBootstrapError', message, details);
  }
}

export class TaskBundleError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('TaskBundleError', message, details);
  }
}

export class TaskRegistryError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('TaskRegistryError', message, details);
  }
}

export class TaskMetaError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('TaskMetaError', message, details);
  }
}

export class ArtifactAttachError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('ArtifactAttachError', message, details);
  }
}

export class ActualizationError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('ActualizationError', message, details);
  }
}

export class RebaselineError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('RebaselineError', message, details);
  }
}

export class McpToolInputError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('McpToolInputError', message, details);
  }
}

export class DoctorError extends V2Error {
  constructor(message: string, details?: unknown) {
    super('DoctorError', message, details);
  }
}
