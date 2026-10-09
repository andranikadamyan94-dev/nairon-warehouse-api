/**
 * The two data-migration specs share the local database and the REQ counter,
 * so jest must never run them in parallel workers: this one file executes both
 * in sequence. Each case file keeps its own describe block.
 */
import './legacy-object-rows-migration.testcase';
import './legacy-task-rows-migration.testcase';
