import * as assert from "assert";
import { EventEmitter } from "events";
import * as api from "../../api-core";
import { IOrderer, IOrdererConnection, IWebSocket } from "../../core";
import { Deferred } from "../../core-utils";
import { MongoManager } from "../../utils";
import { debug } from "../debug";
import { IConcreteNode, IConnectedMessage, IConnectMessage, INode, INodeMessage, IOpMessage } from "./interfaces";
import { IOrdererConnectionFactory, ProxyOrderer } from "./proxyOrderer";
import { Socket } from "./socket";

class ProxySocketConnection implements IOrdererConnection {
    public get clientId(): string {
        return this.details.clientId;
    }

    public get existing(): boolean {
        return this.details.existing;
    }

    public get parentBranch(): string {
        return this.details.parentBranch;
    }

    constructor(
        private socket: IWebSocket,
        private node: RemoteNode,
        private cid: number,
        private details: IConnectedMessage) {
    }

    public order(message: api.IDocumentMessage): void {
        this.node.send(this.cid, "order", message);
    }

    public disconnect(): void {
        this.node.send(this.cid, "disconnect", null);
    }

    public emit(op: string, id: string, ...data: any[]) {
        this.socket.emit(op, id, ...data);
    }
}

class ProxySocketThing implements IOrdererConnectionFactory {
    constructor(private node: RemoteNode, private tenantId: string, private documentId: string) {
        // return;
    }

    public async connect(
        socket: IWebSocket,
        user: api.ITenantUser,
        client: api.IClient): Promise<IOrdererConnection> {

        return this.node.connect(socket, this.tenantId, this.documentId, user, client);
    }
}

interface IPendingConnection {
    deferred: Deferred<IOrdererConnection>;
    socket: IWebSocket;
    tenantId: string;
    documentId: string;
}

/**
 * Connection to a remote node
 */
export class RemoteNode extends EventEmitter implements IConcreteNode {
    public static async Connect(
        id: string,
        mongoManager: MongoManager,
        nodeCollectionName: string): Promise<RemoteNode> {

        // Connect to the given remote node
        const db = await mongoManager.getDatabase();
        const nodeCollection = db.collection<INode>(nodeCollectionName);
        const details = await nodeCollection.findOne({ _id: id });

        const socket = details.expiration >= Date.now()
            ? await Socket.Connect<INodeMessage>(details.address, id)
            : null;
        const node = new RemoteNode(id, socket);

        return node;
    }

    public get id(): string {
        return this._id;
    }

    public get valid(): boolean {
        return this.socket !== null;
    }

    private connectMap = new Map<number, IPendingConnection>();
    private orderers = new Map<string, ProxyOrderer>();
    private topicMap = new Map<string, ProxySocketConnection[]>();
    private cid = 0;

    // TODO establish some kind of connection to the node from here?
    // should I rely on the remote node to update me of its details? And only fall back to mongo if necessary?
    // I can probably assume it's all good so long as it tells me things are good. And then I avoid the update loop.
    // Expired nodes I can track separately.

    // tslint:disable-next-line:variable-name
    private constructor(private _id: string, private socket: Socket<INodeMessage>) {
        super();

        this.socket.on(
            "message",
            (message) => {
                switch (message.type) {
                    case "op":
                        this.route(message.payload as IOpMessage);
                        break;

                    case "connected":
                        const pendingConnect = this.connectMap.get(message.cid);
                        assert(pendingConnect);
                        this.connectMap.delete(message.cid);

                        const socketConnection = new ProxySocketConnection(
                            pendingConnect.socket,
                            this,
                            message.cid,
                            message.payload as IConnectedMessage);

                        // Add new connection to routing tables
                        this.topicMap.set(`client#${socketConnection.clientId}`, [socketConnection]);
                        const fullId = `${pendingConnect.tenantId}/${pendingConnect.documentId}`;
                        if (!this.topicMap.has(fullId)) {
                            this.topicMap.set(fullId, []);
                        }
                        this.topicMap.get(fullId).push(socketConnection);

                        pendingConnect.deferred.resolve(socketConnection);
                        break;
                }
            });
    }

    public async connectOrderer(tenantId: string, documentId: string): Promise<IOrderer> {
        const fullId = `${tenantId}/${documentId}`;
        assert(!this.orderers.has(fullId));
        debug(`Connecting to ${fullId}:${this.id}`);

        const orderer = new ProxyOrderer(new ProxySocketThing(this, tenantId, documentId));
        this.orderers.set(fullId, orderer);

        return orderer;
    }

    public send(cid: number, type: string, payload: any) {
        this.socket.send({
            cid,
            payload,
            type: type as any,
        });
    }

    public async connect(
        socket: IWebSocket,
        tenantId: string,
        documentId: string,
        user: api.ITenantUser,
        client: api.IClient): Promise<IOrdererConnection> {

        const cid = this.getNextCid();
        const connectMessage: IConnectMessage = {
            client,
            documentId,
            tenantId,
            user,
        };

        const deferred = new Deferred<IOrdererConnection>();
        this.connectMap.set(cid, { socket, deferred, tenantId, documentId });
        this.send(cid, "connect", connectMessage);

        return deferred.promise;
    }

    private route(message: IOpMessage) {
        const sockets = this.topicMap.get(message.topic);
        for (const socket of sockets) {
            socket.emit(message.op, message.data[0], ...message.data.slice(1));
        }
    }

    private getNextCid() {
        return this.cid++;
    }
}
