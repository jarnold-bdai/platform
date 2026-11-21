import * as dynamodb from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Mode } from './types.js';

/** Thrown when a migration sends a writing command in `dry-run` or `check`. */
export class ReadOnlyModeError extends Error {
  override name = 'ReadOnlyModeError';
}

/** Commands that never change data or tables. Everything else is refused, unless it is read-only PartiQL. */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  'GetItem', 'BatchGetItem', 'Query', 'Scan', 'TransactGetItems',
  'DescribeTable', 'DescribeTimeToLive', 'DescribeContinuousBackups', 'DescribeContributorInsights', 'DescribeEndpoints',
  'DescribeLimits', 'DescribeKinesisStreamingDestination', 'DescribeTableReplicaAutoScaling', 'DescribeGlobalTable',
  'DescribeGlobalTableSettings', 'DescribeBackup', 'DescribeExport', 'DescribeImport',
  'ListTables', 'ListTagsOfResource', 'ListBackups', 'ListGlobalTables', 'ListContributorInsights', 'ListExports', 'ListImports',
  'GetResourcePolicy',
].map((name) => `${name}Command`));

/** PartiQL commands, allowed only when every statement is a `SELECT`. */
const PARTIQL_COMMANDS: ReadonlySet<string> = new Set(['ExecuteStatementCommand', 'BatchExecuteStatementCommand', 'ExecuteTransactionCommand']);

const KNOWN = [...READ_COMMANDS, ...PARTIQL_COMMANDS];

/**
 * The command's name. Matched by class first (robust to a bundler renaming
 * classes), then by constructor name (robust to a second copy of the SDK).
 */
function commandName(command: unknown): string {
  for (const name of KNOWN) {
    const ctor = (dynamodb as unknown as Record<string, unknown>)[name];
    if (typeof ctor === 'function' && command instanceof ctor) return name;
  }
  const ctorName = (command as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof ctorName === 'string' && ctorName !== '' ? ctorName : 'an unknown command';
}

/** A `SELECT` cannot write in DynamoDB's PartiQL; anything else (or anything unparseable) counts as a write. */
const isSelect = (statement: unknown): boolean => typeof statement === 'string' && /^\s*SELECT\s/i.test(statement);

function isReadOnlyPartiQL(name: string, input: unknown): boolean {
  const statements = (list: unknown): unknown[] => (Array.isArray(list) ? list.map((s) => (s as { Statement?: unknown })?.Statement) : []);
  const i = (input ?? {}) as { Statement?: unknown; Statements?: unknown; TransactStatements?: unknown };
  const all = name === 'ExecuteStatementCommand'
    ? [i.Statement]
    : statements(name === 'BatchExecuteStatementCommand' ? i.Statements : i.TransactStatements);
  return all.length > 0 && all.every(isSelect);
}

/** Why `name` with `input` is refused in `mode`, or undefined when it only reads. */
function refusal(mode: Mode, name: string, input: unknown): ReadOnlyModeError | undefined {
  if (READ_COMMANDS.has(name)) return undefined;
  if (PARTIQL_COMMANDS.has(name) && isReadOnlyPartiQL(name, input)) return undefined;
  const what = PARTIQL_COMMANDS.has(name) ? `${name} (a statement that is not a SELECT)` : name;
  return new ReadOnlyModeError(
    `${mode} is read-only: ctx.dynamo refused ${what}. Write only when ctx.mode === 'write', `
    + 'and call ctx.report.pending() for what you would write.',
  );
}

type Send = (command: unknown, ...rest: unknown[]) => unknown;
type Stack = DynamoDBClient['middlewareStack'];

/**
 * The caller's client, wrapped so that it only reads: every command that
 * could change data or tables is refused with a `ReadOnlyModeError` before it
 * is sent, and reads go to the caller's own client unchanged. A client built
 * on top of it (e.g. `DynamoDBDocumentClient.from(ctx.dynamo)`) takes over a
 * copy of its middleware stack that refuses the same commands.
 */
export function readOnlyDynamo(client: DynamoDBClient, mode: Mode): DynamoDBClient {
  const send: Send = (command, ...rest) => {
    const error = refusal(mode, commandName(command), (command as { input?: unknown } | null)?.input);
    if (!error) return (client.send as Send).call(client, command, ...rest);
    const callback = rest.at(-1);
    if (typeof callback === 'function') {
      (callback as (err: unknown) => void)(error);
      return undefined;
    }
    return Promise.reject(error);
  };
  let stack: Stack | undefined;
  const guardedStack = (): Stack => {
    if (!stack) {
      stack = client.middlewareStack.clone();
      stack.add(
        (next, context) => async (args) => {
          const error = refusal(mode, String(context.commandName ?? 'an unknown command'), args.input);
          if (error) throw error;
          return next(args);
        },
        { step: 'initialize', priority: 'high', name: 'migrationReadOnlyGuard' },
      );
    }
    return stack;
  };
  return new Proxy(client, {
    get(target, property) {
      if (property === 'send') return send;
      if (property === 'middlewareStack') return guardedStack();
      return Reflect.get(target, property, target);
    },
  });
}
