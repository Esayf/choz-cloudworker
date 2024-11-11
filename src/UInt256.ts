import { createForeignField } from "o1js";

export class UInt256 extends createForeignField(1n << 256n) {}
