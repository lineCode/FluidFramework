import { IClient, IClientJoin, IDocumentMessage, IUser, MessageType } from "@prague/runtime-definitions";
import * as assert from "assert";
import { EventEmitter } from "events";
import * as moniker from "moniker";
// tslint:disable-next-line:no-var-requires
const now = require("performance-now");
import { BBCLambda } from "../../bbc/lambda";
import { ICollection, IOrdererConnection, ITenantManager } from "../../core";
import * as core from "../../core";
import { DeliLambda } from "../../deli/lambda";
import { ActivityCheckingTimeout, ClientSequenceTimeout } from "../../deli/lambdaFactory";
import { IContext } from "../../kafka-service/lambdas";
import { ScriptoriumLambda } from "../../scriptorium/lambda";
import { TmzLambda } from "../../tmz/lambda";
import { IMessage, IProducer } from "../../utils";

export interface ISubscriber {
    id: string;

    send(topic: string, ...args: any[]): void;
}

class WebSocketSubscriber implements ISubscriber {
    public get id(): string {
        return this.socket.id;
    }

    constructor(private socket: core.IWebSocket) {
    }

    public send(topic: string, ...args: any[]): void {
        this.socket.emit(args[0], ...args.slice(1));
    }
}

export interface IPubSub {
    // Registers a subscriber for the given message
    subscribe(topic: string, subscriber: ISubscriber);

    // Removes the subscriber
    unsubscribe(topic: string, subscriber: ISubscriber);

    // Publishes a message to the given topic
    publish(topic: string, ...args: any[]): void;
}

class PubSub implements IPubSub {
    private topics = new Map<string, Map<string, { subscriber: ISubscriber, count: number }>>();

    public publish(topic: string, ...args: any[]): void {
        const subscriptions = this.topics.get(topic);
        if (subscriptions) {
            for (const [, value] of subscriptions) {
                value.subscriber.send(topic, ...args);
            }
        }
    }

    // Subscribes to a topic. The same subscriber can be added multiple times. In this case we maintain a ref count
    // on the total number of times it has been subscribed. But we will only publish to it once.
    public subscribe(topic: string, subscriber: ISubscriber) {
        if (!this.topics.has(topic)) {
            this.topics.set(topic, new Map<string, { subscriber: ISubscriber, count: number }>());
        }

        const subscriptions = this.topics.get(topic);
        if (!subscriptions.has(subscriber.id)) {
            subscriptions.set(subscriber.id, { subscriber, count: 0 });
        }

        subscriptions.get(subscriber.id).count++;
    }

    public unsubscribe(topic: string, subscriber: ISubscriber) {
        assert(this.topics.has(topic));
        const subscriptions = this.topics.get(topic);

        assert(subscriptions.has(subscriber.id));
        const details = subscriptions.get(subscriber.id);
        details.count--;
        if (details.count === 0) {
            subscriptions.delete(subscriber.id);
        }

        if (subscriptions.size === 0) {
            this.topics.delete(topic);
        }
    }
}

class LocalSocketPublisher implements core.IPublisher {
    constructor(private publisher: IPubSub) {
    }

    public on(event: string, listener: (...args: any[]) => void) {
        return;
    }

    public to(topic: string): core.ITopic {
        return {
            emit: (event: string, ...args: any[]) => this.publisher.publish(topic, event, ...args),
        };
    }
}

// Want a pure local orderer that can do all kinds of stuff
class LocalContext implements IContext {
    public checkpoint(offset: number) {
        return;
    }

    public error(error: any, restart: boolean) {
        return;
    }
}

class LocalOrdererConnection implements IOrdererConnection {
    public readonly parentBranch: string;

    constructor(
        private pubsub: IPubSub,
        public socket: ISubscriber,
        public readonly existing: boolean,
        document: core.IDocument,
        private producer: IProducer,
        public readonly tenantId: string,
        public readonly documentId: string,
        public readonly clientId: string,
        private user: IUser,
        private client: IClient,
        public readonly maxMessageSize: number) {

        this.parentBranch = document.parent ? document.parent.documentId : null;

        // Subscribe to the message channels
        this.pubsub.subscribe(`${this.tenantId}/${this.documentId}`, this.socket);
        this.pubsub.subscribe(`client#${this.clientId}`, this.socket);

        // Send the connect message
        const clientDetail: IClientJoin = {
            clientId: this.clientId,
            detail: this.client,
        };

        const message: core.IRawOperationMessage = {
            clientId: null,
            documentId: this.documentId,
            operation: {
                clientSequenceNumber: -1,
                contents: null,
                metadata: {
                    content: clientDetail,
                    split: false,
                },
                referenceSequenceNumber: -1,
                traces: [],
                type: MessageType.ClientJoin,
            },
            tenantId: this.tenantId,
            timestamp: Date.now(),
            type: core.RawOperationType,
            user: this.user,
        };

        // Submit on next tick to sequence behind connect response
        this.submitRawOperation(message);
    }

    public order(message: IDocumentMessage): void {
        const rawMessage: core.IRawOperationMessage = {
            clientId: this.clientId,
            documentId: this.documentId,
            operation: message,
            tenantId: this.tenantId,
            timestamp: Date.now(),
            type: core.RawOperationType,
            user: this.user,
        };

        this.submitRawOperation(rawMessage);
    }

    public disconnect() {
        const message: core.IRawOperationMessage = {
            clientId: null,
            documentId: this.documentId,
            operation: {
                clientSequenceNumber: -1,
                contents: null,
                metadata: {
                    content: this.clientId,
                    split: false,
                },
                referenceSequenceNumber: -1,
                traces: [],
                type: MessageType.ClientLeave,
            },
            tenantId: this.tenantId,
            timestamp: Date.now(),
            type: core.RawOperationType,
            user: this.user,
        };
        this.submitRawOperation(message);

        this.pubsub.unsubscribe(`${this.tenantId}/${this.documentId}`, this.socket);
        this.pubsub.unsubscribe(`client#${this.clientId}`, this.socket);
    }

    private submitRawOperation(message: core.IRawOperationMessage) {
        // Add trace
        const operation = message.operation as IDocumentMessage;
        if (operation && operation.traces) {
            operation.traces.push(
                {
                    action: "start",
                    service: "alfred",
                    timestamp: now(),
                });
        }

        // Submits the message.
        this.producer.send(JSON.stringify(message), this.documentId);
    }
}

/**
 * Performs local ordering of messages based on an in-memory stream of operations.
 */
export class LocalOrderer implements core.IOrderer {

    public static async Load(
        storage: core.IDocumentStorage,
        databaseManager: core.IDatabaseManager,
        tenantId: string,
        documentId: string,
        taskMessageSender: core.ITaskMessageSender,
        tenantManager: ITenantManager,
        permission: any,
        maxMessageSize: number) {

        const [details, documentCollection, deltasCollection] = await Promise.all([
            storage.getOrCreateDocument(tenantId, documentId),
            databaseManager.getDocumentCollection(),
            databaseManager.getDeltaCollection(tenantId, documentId),
        ]);

        return new LocalOrderer(
            details,
            tenantId,
            documentId,
            documentCollection,
            deltasCollection,
            taskMessageSender,
            tenantManager,
            permission,
            maxMessageSize);
    }

    private static pubSub = new PubSub();
    private static socketPublisher = new LocalSocketPublisher(LocalOrderer.pubSub);

    private static bbcContext = new LocalContext();
    private static scriptoriumContext = new LocalContext();
    private static tmzContext = new LocalContext();
    private static deliContext = new LocalContext();

    private scriptoriumLambda: ScriptoriumLambda;
    private tmzLambda: TmzLambda;
    private deliLambda: DeliLambda;
    private bbcLambda: BBCLambda;

    private alfredToDeliKafka: InMemoryKafka;
    private deliToScriptoriumKafka: InMemoryKafka;

    private existing: boolean;

    constructor(
        private details: core.IDocumentDetails,
        private tenantId: string,
        private documentId: string,
        documentCollection: ICollection<core.IDocument>,
        deltasCollection: ICollection<any>,
        private taskMessageSender: core.ITaskMessageSender,
        private tenantManager: ITenantManager,
        private permission: any,
        private maxMessageSize: number) {

        this.existing = details.existing;

        // TODO I want to maintain an inbound queue. On lambda failures I need to recreate all of them. Just
        // like what happens when the service goes down.

        // In memory kafka.
        this.alfredToDeliKafka = new InMemoryKafka(this.existing ? details.value.sequenceNumber : 0);
        this.deliToScriptoriumKafka = new InMemoryKafka();

        // Scriptorium + BBC Lambda
        this.scriptoriumLambda = new ScriptoriumLambda(deltasCollection, undefined, LocalOrderer.scriptoriumContext);
        this.bbcLambda = new BBCLambda(LocalOrderer.socketPublisher, LocalOrderer.bbcContext);

        // TMZ lambda
        this.tmzLambda = new TmzLambda(
            this.taskMessageSender,
            this.tenantManager,
            this.permission,
            LocalOrderer.tmzContext);

        // Deli lambda
        this.deliLambda = new DeliLambda(
            LocalOrderer.deliContext,
            tenantId,
            documentId,
            details.value,
            documentCollection,
            this.deliToScriptoriumKafka,
            this.alfredToDeliKafka,
            ClientSequenceTimeout,
            ActivityCheckingTimeout);

        this.startLambdas();
    }

    public async connect(
        socket: core.IWebSocket,
        user: IUser,
        client: IClient): Promise<IOrdererConnection> {

        const socketSubscriber = new WebSocketSubscriber(socket);
        const orderer = this.connectInternal(socketSubscriber, user, client);
        return orderer;
    }

    public connectInternal(
        subscriber: ISubscriber,
        user: IUser,
        client: IClient): IOrdererConnection {
        const clientId = moniker.choose();

        // Create the connection
        const connection = new LocalOrdererConnection(
            LocalOrderer.pubSub,
            subscriber,
            this.existing,
            this.details.value,
            this.alfredToDeliKafka,
            this.tenantId,
            this.documentId,
            clientId,
            user,
            client,
            this.maxMessageSize);

        // document is now existing regardless of the original value
        this.existing = true;

        return connection;
    }

    public async close() {
        // close in-memory kafkas
        this.alfredToDeliKafka.close();
        this.deliToScriptoriumKafka.close();

        // close lambas
        this.bbcLambda.close();
        this.scriptoriumLambda.close();
        this.tmzLambda.close();
        this.deliLambda.close();
    }

    private startLambdas() {
        this.alfredToDeliKafka.on("message", (message: IMessage) => {
            this.deliLambda.handler(message);
        });

        this.deliToScriptoriumKafka.on("message", (message: IMessage) => {
            this.bbcLambda.handler(message);
            this.scriptoriumLambda.handler(message);
            this.tmzLambda.handler(message);
        });
    }
}

// Dumb local in memory kafka.
// TODO: Make this real.
class InMemoryKafka extends EventEmitter implements IProducer {
    constructor(private offset = 0) {
        super();
    }

    public async send(message: string, topic: string): Promise<any> {
        const kafkaMessage: IMessage = {
            highWaterOffset: this.offset,
            key: topic,
            offset: this.offset,
            partition: 0,
            topic,
            value: message,
        };
        this.emit("message", kafkaMessage);
        this.offset++;
    }

    public close(): Promise<void> {
        return Promise.resolve();
    }
}
