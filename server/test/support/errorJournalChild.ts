import { ErrorJournal } from '../../observability/journal';
import { SqliteErrorSink } from '../../observability/database';
const j = new ErrorJournal({ directory: process.env.ERROR_TEST_DIR!,
  sink: new SqliteErrorSink(process.env.ERROR_TEST_FILE!),
  afterCommit: () => process.exit(0) });
await j.record(new Error('commit 뒤 실제 프로세스 종료'), { id: process.env.ERROR_TEST_ID!, component: 'test', operation: 'child.crash' });
await j.deliver();
throw new Error('종료 주입이 실행되지 않았다');
