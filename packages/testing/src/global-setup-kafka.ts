import { createServer } from 'node:net';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

let container: StartedTestContainer | undefined;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

/**
 * Vitest globalSetup: one real single-node Kafka (KRaft, no ZooKeeper) for the run, the same image
 * and listener layout as docker-compose.yml. The EXTERNAL listener advertises the host port we map
 * it to, which is why the host port must be chosen first. Set TEST_KAFKA_BROKERS to reuse a broker.
 */
export async function setup(project: TestProject) {
  if (process.env.TEST_KAFKA_BROKERS) {
    project.provide('kafkaBrokers', process.env.TEST_KAFKA_BROKERS);
    return;
  }
  const port = await freePort();
  container = await new GenericContainer('apache/kafka:3.9.0')
    .withExposedPorts({ container: 9094, host: port })
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:9094',
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:9092,EXTERNAL://localhost:${port}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,EXTERNAL:PLAINTEXT',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(180_000)
    .start();
  project.provide('kafkaBrokers', `localhost:${port}`);
}

export async function teardown() {
  await container?.stop();
}
