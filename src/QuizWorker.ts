import {
    zkCloudWorker,
    Cloud,
    fee,
    sleep,
    deserializeFields,
    fetchMinaAccount,
    accountBalanceMina,
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
} from "o1js";
import { Quiz, QuizState, WinnerState } from "./Quiz";
import { ScoreCalculationLoop, UserAnswers, CorrectAnswers } from "./ScoreCalculationLoop";

export class QuizWorker extends zkCloudWorker {
    static quizVerificationKey: VerificationKey | undefined = undefined;
    static scoreCalculationVerificationKey: VerificationKey | undefined = undefined;
    readonly cache: Cache;

    constructor(cloud: Cloud) {
        super(cloud);
        this.cache = Cache.FileSystem(this.cloud.cache);
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

    public async calculateScore(transaction: string): Promise<string | undefined> {
        const msg = `score calculated`;
        console.time(msg);
        const args = JSON.parse(transaction);

        const userAnswers: UserAnswers = UserAnswers.fromFields(
            deserializeFields(args.userAnswers)
        ) as UserAnswers;

        const correctAnswers: CorrectAnswers = CorrectAnswers.fromFields(
            deserializeFields(args.correctAnswers)
        ) as CorrectAnswers;

        await this.compile();
        if (QuizWorker.scoreCalculationVerificationKey === undefined)
            throw new Error("verificationKey is undefined");

        const proof = await ScoreCalculationLoop.calculateScore(userAnswers, correctAnswers);
        console.timeEnd(msg);

        return JSON.stringify(proof.proof.toJSON(), null, 2);
    }

    public async execute(transactions: string[]): Promise<string | undefined> {
        if (this.cloud.args === undefined)
            throw new Error("this.cloud.args is undefined");
        const args = JSON.parse(this.cloud.args);
        
        if (args.contractAddress === undefined)
            throw new Error("args.contractAddress is undefined");

        switch (this.cloud.task) {
            case "initQuiz":
                return await this.initQuiz(args);
            
            case "setWinner":
                return await this.setWinner(args);

            case "payoutWinners":
                return await this.payoutWinners(args);

            case "settleQuiz":
                return await this.settleQuiz(args);

            default:
                throw new Error(`Unknown task: ${this.cloud.task}`);
        }
    }

    private async initQuiz(args: {
        contractAddress: string;
        secretKey: string;
        duration: string;
        startDate: string;
        totalRewardPoolAmount: string;
    }): Promise<string> {
        await this.compile();
        const deployerKeyPair = await this.cloud.getDeployer();
        if (deployerKeyPair === undefined)
            throw new Error("deployerKeyPair is undefined");
        
        const deployer = PrivateKey.fromBase58(deployerKeyPair.privateKey);
        const sender = deployer.toPublicKey();
        const contractAddress = PublicKey.fromBase58(args.contractAddress);
        const zkApp = new Quiz(contractAddress);

        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "init quiz" },
            async () => {
                await zkApp.initQuizState(
                    Field(args.secretKey),
                    UInt64.from(args.duration),
                    UInt64.from(args.startDate),
                    UInt64.from(args.totalRewardPoolAmount)
                );
            }
        );

        await tx.prove();
        tx.sign([deployer]);

        const txSent = await tx.send();
        await this.cloud.releaseDeployer({
            publicKey: deployerKeyPair.publicKey,
            txsHashes: txSent?.hash ? [txSent.hash] : [],
        });

        return txSent?.hash ?? "Error sending transaction";
    }

    private async setWinner(args: {
        contractAddress: string;
        winner: string;
        amount: string;
        finishDate: string;
    }): Promise<string> {
        await this.compile();
        const deployerKeyPair = await this.cloud.getDeployer();
        if (deployerKeyPair === undefined)
            throw new Error("deployerKeyPair is undefined");

        const deployer = PrivateKey.fromBase58(deployerKeyPair.privateKey);
        const sender = deployer.toPublicKey();
        const contractAddress = PublicKey.fromBase58(args.contractAddress);
        const zkApp = new Quiz(contractAddress);
        const winner = PublicKey.fromBase58(args.winner);

        const winnerState = new WinnerState({
            amount: UInt64.from(args.amount),
            isPaid: Bool(false),
            finishDate: UInt64.from(args.finishDate)
        });

        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "set winner" },
            async () => {
                await zkApp.setWinner(winner, winnerState);
            }
        );

        await tx.prove();
        tx.sign([deployer]);

        const txSent = await tx.send();
        await this.cloud.releaseDeployer({
            publicKey: deployerKeyPair.publicKey,
            txsHashes: txSent?.hash ? [txSent.hash] : [],
        });

        return txSent?.hash ?? "Error sending transaction";
    }

    private async payoutWinners(args: {
        contractAddress: string;
        winner1: string;
        winner2: string;
        winner3: string;
    }): Promise<string> {
        await this.compile();
        const deployerKeyPair = await this.cloud.getDeployer();
        if (deployerKeyPair === undefined)
            throw new Error("deployerKeyPair is undefined");

        const deployer = PrivateKey.fromBase58(deployerKeyPair.privateKey);
        const sender = deployer.toPublicKey();
        const contractAddress = PublicKey.fromBase58(args.contractAddress);
        const zkApp = new Quiz(contractAddress);

        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "payout winners" },
            async () => {
                await zkApp.payoutByThree(
                    PublicKey.fromBase58(args.winner1),
                    PublicKey.fromBase58(args.winner2),
                    PublicKey.fromBase58(args.winner3)
                );
            }
        );

        await tx.prove();
        tx.sign([deployer]);

        const txSent = await tx.send();
        await this.cloud.releaseDeployer({
            publicKey: deployerKeyPair.publicKey,
            txsHashes: txSent?.hash ? [txSent.hash] : [],
        });

        return txSent?.hash ?? "Error sending transaction";
    }

    private async settleQuiz(args: {
        contractAddress: string;
    }): Promise<string> {
        await this.compile();
        const deployerKeyPair = await this.cloud.getDeployer();
        if (deployerKeyPair === undefined)
            throw new Error("deployerKeyPair is undefined");

        const deployer = PrivateKey.fromBase58(deployerKeyPair.privateKey);
        const sender = deployer.toPublicKey();
        const contractAddress = PublicKey.fromBase58(args.contractAddress);
        const zkApp = new Quiz(contractAddress);
        const settlementProof = await zkApp.offchainState.createSettlementProof();
        
        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "settle quiz" },
            async () => {
                await zkApp.settle(settlementProof);
            }
        );

        await tx.prove();
        tx.sign([deployer]);

        const txSent = await tx.send();
        await this.cloud.releaseDeployer({
            publicKey: deployerKeyPair.publicKey,
            txsHashes: txSent?.hash ? [txSent.hash] : [],
        });

        return txSent?.hash ?? "Error sending transaction";
    }
} 