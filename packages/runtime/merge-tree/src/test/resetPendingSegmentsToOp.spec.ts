/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as assert from "assert";
import { IMergeTreeOp } from "../ops";
import { TestClient } from "./testClient";

describe("resetPendingSegmentsToOp", () => {
    let client: TestClient;
    let opList: IMergeTreeOp[];
    let opCount: number = 0;
    const insertCount = 5;

    function applyOpList(cli: TestClient) {
        while (opList.length > 0) {
            const op = opList.shift();
            if (op) {
                const seqOp = cli.makeOpMessage(op, ++opCount);
                cli.applyMsg(seqOp);
            }
        }
    }

    beforeEach(() => {
        client = new TestClient();
        client.startCollaboration("local user");
        assert(client.mergeTree.pendingSegments.empty());
        opList = [];

        for (let i = 0; i < insertCount; i++) {
            const op = client.insertTextLocal(i, "hello");
            opList.push(op);
            assert.equal(client.mergeTree.pendingSegments.count(), i + 1);
        }
    });

    it("acked insertSegment", async () => {
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());

        client.resetPendingSegmentsToOp();
        assert(client.mergeTree.pendingSegments.empty());
    });

    it("nacked insertSegment", async () => {
        opList.push(client.resetPendingSegmentsToOp());
        // we expect a nack op per segment since our original ops split segments
        // we should expect mores nack ops then original ops.
        // only the first op didn't split a segment, all the others did
        assert.equal(client.mergeTree.pendingSegments.count(), (insertCount * 2) - 1);
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());
    });

    it("acked removeRange", async () => {
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());

        opList.push(client.removeRangeLocal(0, client.getLength()));
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());

        client.resetPendingSegmentsToOp();
        assert(client.mergeTree.pendingSegments.empty());
    });

    it("nacked removeRange", async () => {
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());

        opList.push(client.removeRangeLocal(0, client.getLength()));
        opList.push(client.resetPendingSegmentsToOp());
        // we expect a nack op per segment since our original ops split segments
        // we should expect mores nack ops then original ops.
        // only the first op didn't split a segment, all the others did
        assert.equal(client.mergeTree.pendingSegments.count(), (insertCount * 2) - 1);
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());
    });

    it("nacked insertSegment and removeRange", async () => {
        // if a segment is inserted and removed, we don't need to do anything on nack
        client.removeRangeLocal(0, client.getLength());
        client.resetPendingSegmentsToOp();
        assert(client.mergeTree.pendingSegments.empty());
    });

    it("acked annotateRange", async () => {
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());

        opList.push(client.annotateRangeLocal(0, client.getLength(), { foo: "bar" }, undefined));
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());

        client.resetPendingSegmentsToOp();
        assert(client.mergeTree.pendingSegments.empty());
    });

    it("nacked annotateRange", async () => {
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());

        opList.push(client.annotateRangeLocal(0, client.getLength(), { foo: "bar" }, undefined));
        opList.push(client.resetPendingSegmentsToOp());
        // we expect a nack op per segment since our original ops split segments
        // we should expect mores nack ops then original ops.
        // only the first op didn't split a segment, all the others did
        assert.equal(client.mergeTree.pendingSegments.count(), (insertCount * 2) - 1);
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());
    });

    it("nacked insertSegment and annotateRange", async () => {
        opList.push(client.annotateRangeLocal(0, client.getLength(), { foo: "bar" }, undefined));
        opList.push(client.resetPendingSegmentsToOp());
        // we expect a nack op per segment since our original ops split segments
        // we should expect mores nack ops then original ops.
        // only the first op didn't split a segment, all the others did
        assert.equal(client.mergeTree.pendingSegments.count(), (insertCount * 2) - 1);
        applyOpList(client);
        assert(client.mergeTree.pendingSegments.empty());
    });
});