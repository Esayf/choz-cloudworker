import {
    zkCloudWorker,
    Cloud,
    fee,
    sleep,
    deserializeFields,
    fetchMinaAccount,
    accountBalanceMina,
    serializeIndexedMap,
    parseIndexedMapSerialized,
    deserializeIndexedMerkleMap,
    IndexedMapSerialized,
    blockchain,
    serializeTransaction,
    deserializeTransaction,
    transactionParams,
} from "zkcloudworker";
import {
    verify,
    type JsonProof,
    VerificationKey,
    PublicKey,
    Mina,
    PrivateKey,
    AccountUpdate,
    Cache,
    UInt64,
    Bool,
    Field,
    MerkleMap,
    Proof,
    fetchAccount,
    Permissions
} from "o1js";
import { Quiz, QuizState, WinnerState } from "./Quiz";
import { ScoreCalculationLoop, UserAnswers, CorrectAnswers, ScoreProof } from "./ScoreCalculationLoop";
import { Winner, WinnerInput, WinnerMap, WinnerOutput, WinnersProof, WinnersProver } from "./WinnersProver";
import { IndexedMerkleMapBase } from "o1js/dist/node/lib/provable/merkle-tree-indexed";
import { AuthRequired } from "o1js/dist/node/bindings/mina-transaction/gen/transaction";

export class QuizWorker extends zkCloudWorker {
    static quizVerificationKey: VerificationKey | undefined = undefined;
    static scoreCalculationVerificationKey: VerificationKey | undefined = undefined;
    static winnerVerificationKey: VerificationKey | undefined = undefined;
    readonly cache: Cache;

    constructor(cloud: Cloud) {
        super(cloud);
        this.cache = Cache.FileSystem(this.cloud.cache);
    }

    private stringifyJobResult(result: any): string {
        return JSON.stringify(result, null, 2);
    }
    private async compile(): Promise<void> {
        try {
            console.time("compiled");
            if (QuizWorker.scoreCalculationVerificationKey === undefined) {
                console.time("compiled ScoreCalculationLoop");
                QuizWorker.scoreCalculationVerificationKey = (
                    await ScoreCalculationLoop.compile({
                        cache: this.cache,
                    })
                ).verificationKey;
                console.timeEnd("compiled ScoreCalculationLoop");
            }

            if (QuizWorker.winnerVerificationKey === undefined) {
                console.time("compiled WinnersProver");
                QuizWorker.winnerVerificationKey = (
                    await WinnersProver.compile({
                        cache: this.cache,
                    })
                ).verificationKey;
                console.timeEnd("compiled WinnersProver");
            }

            if (QuizWorker.quizVerificationKey === undefined) {
                console.time("compiled Quiz");
                QuizWorker.quizVerificationKey = (
                    await Quiz.compile({
                        cache: this.cache,
                    })
                ).verificationKey;
                console.timeEnd("compiled Quiz");
            }
            console.timeEnd("compiled");
        } catch (error) {
            console.error("Error in compile, restarting container", error);
            await this.cloud.forceWorkerRestart();
            throw error;
        }
    }

    private async proveAndSendDeployQuizTx(args: {
        contractAddress: string, serializedTransaction: string, signedData: string,
        secretKey: string,
        startDate: string,
        totalRewardPoolAmount: string,
        rewardPerWinner: string,
        duration: string
    }): Promise<string> {
        await this.compile();
        const zkApp = new Quiz(PublicKey.fromBase58(args.contractAddress));
        const signedJson = JSON.parse(args.signedData);
        console.log("signedJson is here on prove", signedJson);
        const { fee, sender, nonce, memo } = transactionParams(
            args.serializedTransaction,
            signedJson
        );
        console.log("Rebuild params:", { sender: sender.toBase58(), fee: fee.toString(), nonce: nonce.toString(), memo });
        const reTransaction = await Mina.transaction(
            { sender: sender, fee: fee, nonce: nonce, memo: memo },
            async () => {
                AccountUpdate.fundNewAccount(sender);
                await zkApp.deploy({ verificationKey: QuizWorker.quizVerificationKey });
                await zkApp.initQuizState(Field(args.secretKey), UInt64.from(args.duration), UInt64.from(args.startDate), UInt64.from(args.totalRewardPoolAmount), UInt64.from(args.rewardPerWinner));
            }
        );

        const tx = deserializeTransaction(args.serializedTransaction, reTransaction, signedJson);
        console.time("proved tx");
        await tx.prove();
        console.timeEnd("proved tx"); const txJSON = tx.toJSON();
        try {

            let txSent;
            let sent = false;
            while (!sent) {
                txSent = await tx.safeSend();
                if (txSent.status == "pending") {
                    sent = true;
                    console.log(
                        `${memo} tx sent: hash: ${txSent.hash} status: ${txSent.status}`
                    );
                } else if (this.cloud.chain === "zeko") {
                    console.log("Retrying Zeko tx");
                    await sleep(10000);
                } else {
                    console.log(
                        `${memo} tx NOT sent: hash: ${txSent?.hash} status: ${txSent?.status}`,
                        txSent.errors
                    );
                    return this.stringifyJobResult({
                        success: false,
                        tx: txJSON,
                        hash: txSent.hash,
                        error: String(txSent.errors),
                    });
                }
            }
            if (this.cloud.isLocalCloud && txSent?.status === "pending") {
                const txIncluded = await txSent.safeWait();
                console.log(
                    `${memo} tx included into block: hash: ${txIncluded.hash} status: ${txIncluded.status}`
                );
                return this.stringifyJobResult({
                    success: true,
                    tx: txJSON,
                    hash: txIncluded.hash,
                });
            }
            if (txSent?.hash)
                this.cloud.publishTransactionMetadata({
                    txId: txSent?.hash,
                    metadata: {
                        sender: sender.toBase58(),
                        contractAddress: args.contractAddress,
                        type: "deploy",
                    } as any,
                });
            return this.stringifyJobResult({
                success:
                    txSent?.hash !== undefined && txSent?.status == "pending"
                        ? true
                        : false,
                tx: txJSON,
                hash: txSent?.hash,
                error: String(txSent?.errors ?? ""),
            });
        } catch (error) {
            console.error("Error sending transaction", error);
            return this.stringifyJobResult({
                success: false,
                tx: txJSON,
                error: String(error),
            });
        }
    }

    public async calculateScore(args: {
        userAnswers: UserAnswers;
        correctAnswers: CorrectAnswers;
    }): Promise<string | undefined> {
        const msg = `score calculated`;
        console.time(msg);

        const userAnswers: UserAnswers = args.userAnswers as UserAnswers;

        const correctAnswers: CorrectAnswers = args.correctAnswers as CorrectAnswers;
        await this.compile();
        if (QuizWorker.scoreCalculationVerificationKey === undefined)
            throw new Error("verificationKey is undefined");

        if (userAnswers.answers.length < 80) {
            for (let i = userAnswers.answers.length; i < 80; i++) {
                userAnswers.answers.push(Field(0));
                correctAnswers.answers.push(Field(7));
            }
        }

        const proof = await ScoreCalculationLoop.calculateScore(userAnswers, correctAnswers);
        console.timeEnd(msg);
        console.log("score", proof.proof.publicOutput);
        return JSON.stringify(proof.proof.toJSON(), null, 2);
    }

    public async initWinnerMap(contractAddress: string): Promise<string> {
        await this.compile();
        const admin = PrivateKey.fromBase58(process.env.ADMIN_PRIVATE_KEY ?? "");
        const sender = admin.toPublicKey();
        console.log("this is sender:", sender.toBase58());
        const proof = await WinnersProver.init(new WinnerInput({
            contractAddress: PublicKey.fromBase58(contractAddress),
            previousWinner: new Winner({
                publicKey: PublicKey.empty(),
                reward: UInt64.from(0),
            }),
            winner: new Winner({
                publicKey: PublicKey.empty(),
                reward: UInt64.from(0),
            }),
            totalPaidReward: UInt64.from(0),
            previousRoot: new MerkleMap().getRoot()
        }), PublicKey.fromBase58(contractAddress));
        const zkApp = new Quiz(PublicKey.fromBase58(contractAddress));
        await fetchMinaAccount({ publicKey: sender, force: true });
        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "init winner map" },
            async () => {
                await zkApp.setWinnersRoot(proof.auxiliaryOutput.root);
            }
        );
        await tx.prove();
        tx.sign([admin]);
        const txSent = await sendTx(tx, "init winner map", this.cloud.chain);
        if (txSent === "Error sending transaction") return txSent;
        await this.cloud.releaseDeployer({
            publicKey: admin.toPublicKey().toBase58(),
            txsHashes: txSent?.hash ? [txSent.hash] : [],
        });
        if (txSent?.hash)
            this.cloud.publishTransactionMetadata({
                txId: txSent?.hash,
                metadata: {
                    sender: sender.toBase58(),
                    contractAddress: contractAddress,
                    type: "init winner map"
                } as any,
            });
        return txSent?.hash ? JSON.stringify({ auxiliaryOutput: serializeIndexedMap(proof.auxiliaryOutput), proof: proof.proof.toJSON() }, null, 2) : "Error sending transaction";
    }

    private async addWinner(args: {
        winner: { publicKey: string; reward: string };
        previousProof: JsonProof;
        serializedStringPreviousMap: IndexedMapSerialized;
    }): Promise<string> {
        await this.compile();

        const winnerPrevProof: {
            proof: Proof<WinnerInput, WinnerOutput>;
            auxiliaryOutput: IndexedMerkleMapBase | undefined;
        } = {
            proof: await WinnersProof.fromJSON(args.previousProof),
            auxiliaryOutput: deserializeIndexedMerkleMap({ serializedIndexedMap: args.serializedStringPreviousMap, type: WinnerMap })
        };
        if (winnerPrevProof.auxiliaryOutput === undefined) throw new Error("winnerPrevProof.auxiliaryOutput is undefined");
        const proof = await WinnersProver.addWinner(new WinnerInput({
            contractAddress: winnerPrevProof.proof.publicOutput.contractAddress,
            previousWinner: winnerPrevProof.proof.publicOutput.winner,
            winner: new Winner({
                publicKey: PublicKey.fromBase58(args.winner.publicKey),
                reward: UInt64.from(args.winner.reward),
            }),
            totalPaidReward: winnerPrevProof.proof.publicOutput.totalPaidReward,
            previousRoot: winnerPrevProof.auxiliaryOutput.root
        }), winnerPrevProof.auxiliaryOutput!, winnerPrevProof.proof);
        return JSON.stringify({ auxiliaryOutput: serializeIndexedMap(proof.auxiliaryOutput), proof: proof.proof.toJSON() }, null, 2);
    }

    public async execute(transactions: string[]): Promise<string | undefined> {
        if (this.cloud.args === undefined)
            throw new Error("this.cloud.args is undefined");
        const args = JSON.parse(this.cloud.args);
        switch (this.cloud.task) {
            case "calculateScore":
                return await this.calculateScore(args);
            case "proveAndSendDeployQuizTx":
                return await this.proveAndSendDeployQuizTx(args);
            case "initWinnerMap":
                const initWinnerMapResult = await this.initWinnerMap(args.contractAddress);
                return initWinnerMapResult;
            case "addWinner":
                return await this.addWinner(args);
            case "payoutOneWinner":
                const payoutOneWinnerResult = await this.payoutOneWinner(args);
                return payoutOneWinnerResult;
            case "payoutWinners":
                const payoutWinnersResult = await this.payoutWinners(args);
                return payoutWinnersResult;

            default:
                throw new Error(`Unknown task: ${this.cloud.task}`);
        }
    }

    private async payoutOneWinner(args: {
        contractAddress: string;
        winner: string;
        proof: JsonProof;
    }): Promise<string> {
        await this.compile();
        let admin: PrivateKey;
        if (process.env.ADMIN_PRIVATE_KEY === undefined) {
            console.log("ADMIN_PRIVATE_KEY is undefined");
            const deployerKeyPair = await this.cloud.getDeployer();
            if (deployerKeyPair === undefined) throw new Error("deployerKeyPair is undefined");
            admin = PrivateKey.fromBase58(deployerKeyPair.privateKey);
        } else {
            admin = PrivateKey.fromBase58(process.env.ADMIN_PRIVATE_KEY);
        }
        const sender = admin.toPublicKey();
        const contractAddress = PublicKey.fromBase58(args.contractAddress);
        const zkApp = new Quiz(contractAddress);
        await fetchMinaAccount({ publicKey: sender, force: true });
        const winnerAccount = await fetchMinaAccount({ publicKey: PublicKey.fromBase58(args.winner) });
        if (winnerAccount.account === undefined) {
            const tx = await Mina.transaction(
                { sender, fee: await fee(), memo: "payout one winner" },
                async () => {
                    AccountUpdate.fundNewAccount(sender);
                    await zkApp.payoutByOne(
                        await WinnersProof.fromJSON(args.proof),
                    );
                }
            );

            await tx.prove();
            tx.sign([admin]);

            const txSent = await sendTx(tx, "payout one winner", this.cloud.chain);
            if (txSent === "Error sending transaction") return JSON.stringify({ success: false, tx: txSent, error: "Error sending transaction" });

            if (txSent?.hash && txSent.status !== "rejected")
                this.cloud.publishTransactionMetadata({
                    txId: txSent?.hash,
                    metadata: {
                        sender: sender.toBase58(),
                        contractAddress: contractAddress.toBase58(),
                        winner: args.winner,
                        type: "payout one winner"
                    } as any,
                });
            if (txSent?.errors) console.error("txSent?.errors", txSent?.errors);

            return txSent?.errors ? JSON.stringify({ success: false, tx: txSent, error: txSent.errors }) : JSON.stringify({ success: true, tx: txSent });
        }

        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "payout one winner" },
            async () => {
                await zkApp.payoutByOne(
                    await WinnersProof.fromJSON(args.proof),
                );
            }
        );

        await tx.prove();
        tx.sign([admin]);

        const txSent = await sendTx(tx, "payout one winner", this.cloud.chain);
        return await this.handleTransactionResult(txSent, {
            sender: sender.toBase58(),
            contractAddress: contractAddress.toBase58(),
            winner: args.winner,
            type: "payout one winner"
        });
    }

    private async payoutWinners(args: {
        contractAddress: string;
        winner1: string;
        winner2: string;
        winner1Proof: JsonProof;
        winner2Proof: JsonProof;
    }): Promise<string> {
        await this.compile();

        // Get admin key
        const admin = process.env.ADMIN_PRIVATE_KEY
            ? PrivateKey.fromBase58(process.env.ADMIN_PRIVATE_KEY)
            : PrivateKey.fromBase58((await this.cloud.getDeployer())!.privateKey);
        const sender = admin.toPublicKey();
        const contractAddress = PublicKey.fromBase58(args.contractAddress);
        const zkApp = new Quiz(contractAddress);

        // Fetch accounts
        await fetchMinaAccount({ publicKey: sender, force: true });
        const winner1Account = await fetchMinaAccount({ publicKey: PublicKey.fromBase58(args.winner1) });
        const winner2Account = await fetchMinaAccount({ publicKey: PublicKey.fromBase58(args.winner2) });

        // Create transaction
        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "payout winners" },
            async () => {
                // Fund new accounts if needed
                const undefinedAccounts = [winner1Account, winner2Account]
                    .filter(acc => acc.account === undefined).length;
                if (undefinedAccounts === 2) {
                    AccountUpdate.fundNewAccount(sender, 2);
                } else if (undefinedAccounts === 1) {
                    AccountUpdate.fundNewAccount(sender);
                }

                // Execute payout
                await zkApp.payoutByTwo(
                    await WinnersProof.fromJSON(args.winner1Proof),
                    await WinnersProof.fromJSON(args.winner2Proof)
                );
            }
        );

        await tx.prove();
        tx.sign([admin]);

        // Send transaction
        const txSent = await sendTx(tx, "payout winners", this.cloud.chain);
        return await this.handleTransactionResult(txSent, {
            sender: sender.toBase58(),
            contractAddress: contractAddress.toBase58(),
            winner1: args.winner1,
            winner2: args.winner2,
            type: "payout winners"
        });
    }
    private async handleTransactionResult(
        txSent: Awaited<ReturnType<typeof sendTx>>,
        metadata: {
            sender: string,
            contractAddress: string,
            type: string,
            [key: string]: any
        }): Promise<string> {
        if (txSent === "Error sending transaction") {
            console.error("Error sending transaction", txSent);
            return JSON.stringify({
                success: false,
                tx: txSent,
                error: "Error sending transaction"
            });
        }

        // Publish metadata if transaction successful
        if (txSent?.hash && txSent.status !== "rejected") {
            this.cloud.publishTransactionMetadata({
                txId: txSent.hash,
                metadata: { custom: metadata }
            });
        }

        if (txSent?.errors) console.error("txSent?.errors", txSent?.errors);
        return JSON.stringify({
            success: !txSent?.errors,
            tx: txSent,
            error: txSent?.errors || undefined
        });
    }
}


async function sendTx(
    tx: Mina.Transaction<false, true> | Mina.Transaction<true, true>,
    description?: string,
    chain: blockchain = "local"
) {
    try {
        let txSent;
        let sent = false;
        while (!sent) {
            txSent = await tx.safeSend();
            if (txSent.status == "pending") {
                sent = true;
                console.log(
                    `${description ?? ""} tx sent: hash: ${txSent.hash} status: ${txSent.status
                    }`
                );
            } else if (chain === "zeko") {
                console.log("Retrying Zeko tx");
                await sleep(10000);
            } else {
                console.log(
                    `${description ?? ""} tx NOT sent: hash: ${txSent?.hash} status: ${txSent?.status
                    }`
                );
                console.log("Errors:", txSent.errors);
                return "Error sending transaction";
            }
        }
        if (txSent === undefined) throw new Error("txSent is undefined");
        if (txSent.errors.length > 0) {
            console.error(
                `${description ?? ""} tx error: hash: ${txSent.hash} status: ${txSent.status
                }  errors: ${txSent.errors}`
            );
        }

        if (txSent.status === "pending") {
            console.log(`Waiting for tx inclusion...`);
            const txIncluded = await txSent.safeWait();
            console.log(
                `${description ?? ""} tx included into block: hash: ${txIncluded.hash
                } status: ${txIncluded.status}`
            );
        }
        return txSent;
    } catch (error) {
        if (chain !== "zeko") console.error("Error sending tx", error);
    }
    if (chain !== "local") await sleep(10000);
}