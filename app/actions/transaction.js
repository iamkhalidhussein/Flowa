'use server';

import aj from "@/lib/arcjet";
import { db } from "@/lib/prisma";
import { categories, request } from "@arcjet/next";
import { auth } from "@clerk/nextjs/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { revalidatePath } from "next/cache";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const serializeAmount = (obj) => ({
    ...obj,
    amount: obj.amount.toNumber(),
});
// Create a new transaction and update account balance atomically
export const createTransaction = async (data) => {
    try {
        const { userId } = await auth();
        if (!userId) {
            throw new Error("Unauthorized");
        }

        // Apply rate limiting using Arcjet
        const req = await request();
        // Check rate limit
        const decision = await aj.protect(req, {
            userId,
            requested: 1, // Specify how many tokens to consume
        });

        if (decision.isDenied()) {
            if (decision.reason.isRateLimit()) {
                const { remaining, reset } = decision.reason;
                console.error({
                    code: "RATE_LIMIT_EXCEEDED",
                    details: {
                        remaining,
                        resetInSeconds: reset,
                    },
                });

                console.log("Throwing error!");
                throw new Error("Too many requests. Please try again later.");
            }

            throw new Error("Request Blocked");
        }

        // Find user and account in database
        const user = await db.user.findUnique({
            where: {
                clerkUserId: userId
            },
        });

        if (!user) {
            throw new Error("User not found");
        }

        const account = await db.account.findUnique({
            where: {
                id: data.accountId,
                userId: user.id,
            },
        });

        if (!account) {
            throw new Error("Account not found");
        }

        // Calculate new balance based on transaction type
        const balanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;
        const newBalance = account.balance.toNumber() + balanceChange;

        // Create transaction and update account balance in a DB transaction
        const transaction = await db.$transaction(async (tx) => {
            const newTransaction = await tx.transaction.create({
                data: {
                    ...data,
                    userId: user.id,
                    nextRecurringDate: data.isRecurring && data.recurringInterval ? calculateNextRecurringDate(data.date, data.recurringInterval) : null,
                },
            });

            await tx.account.update({
                where: {
                    id: data.accountId,
                },
                data: {
                    balance: newBalance
                },
            });

            return newTransaction;
        });

        revalidatePath("/dashboard");
        revalidatePath(`/account/${transaction.accountId}`);

        return { success: true, data: serializeAmount(transaction) };
    } catch (error) {
        throw new Error(error.message);
    }
}

// Helper function to calculate next recurring date 
const calculateNextRecurringDate = (startDate, interval) => {
    const date = new Date(startDate);

    switch (interval) {
        case "DAILY":
            date.setDate(date.getDate() + 1);
            break;
        case "WEEKLY":
            date.setDate(date.getDate() + 7);
            break;
        case "MONTHLY":
            date.setDate(date.getMonth() + 1);
            break;
        case "YEARLY":
            date.setDate(date.getFullYear() + 1);
            break;
    }
};
// Scans a receipt image using Gemini AI and extracts structured transaction data.
// Converts the uploaded file to base64, sends it to Gemini with a prompt for JSON extraction.
// Parses the AI response and returns amount, date, description, merchant name, and category.
// Handles errors for invalid responses or failed AI calls.
// Returns an empty object if the image is not a receipt.
export const scanReceipt = async (file) => {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Convert File to ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();

        // Convert ArrayBuffer to Base64
        const base64String = Buffer.from(arrayBuffer).toString("base64");

        const prompt = `
        Analyze this receipt image and extract the following information in JSON format:
      - Total amount (just the number)
      - Date (in ISO format)
      - Description or items purchased (brief summary)
      - Merchant/store name
      - Suggested category (one of: housing,transportation,groceries,utilities,entertainment,food,shopping,healthcare,education,personal,travel,insurance,gifts,bills,other-expense )
      
      Only respond with valid JSON in this exact format:
      {
        "amount": number,
        "date": "ISO date string",
        "description": "string",
        "merchantName": "string",
        "category": "string"
      }

      If its not a receipt, return an empty object`;

        const result = await model.generateContent([
            {
                inlineData: {
                    data: base64String,
                    mimeType: file.type,
                },
            },
            prompt,
        ]);

        const response = result.response;
        const text = response.text();
        const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

        try {
            const data = JSON.parse(cleanedText);
            return {
                amount: parseFloat(data.amount),
                date: new Date(data.date),
                description: data.description,
                category: data.category,
                merchantName: data.merchantName,
            };
        } catch (parseError) {
            console.error("Error parsing JSON response:", parseError);
            throw new Error("Invalid response format from Gemini");
        }
    } catch (error) {
        console.error("Error scanning receipt:", error.message);
        throw new Error("Failed to scan receipt");
    }
}

// Retrieves a single transaction for the authenticated user by its ID.
// Checks user authentication and fetches user from the database.
// Finds the transaction belonging to the user and returns it with the amount serialized.
// Throws errors if the user or transaction is not found.
// Used for displaying transaction details in the UI.
export const getTransaction = async (id) => {
    const { userId } = await auth();
    if (!userId) {
        throw new Error("Unauthorized");
    }

    const user = await db.user.findUnique({
        where: {
            clerkUserId: userId
        },
    });

    if (!user) {
        throw new Error("User not found");
    }

    const transaction = await db.transaction.findUnique({
        where: {
            id,
            userId: user.id,
        },
    });

    if (!transaction) throw new Error("Transaction not found");

    return serializeAmount(transaction);
}

export const updateTransaction = async (id, data) => {
    try {
        const { userId } = await auth();
        if (!userId) {
            throw new Error("Unauthorized");
        }

        const user = await db.user.findUnique({
            where: {
                clerkUserId: userId
            },
        });

        if (!user) {
            throw new Error("User not found");
        }

        // Get original transaction to calculate balance change
        const originalTransaction = await db.transaction.findUnique({
            where: {
                id,
                userId: user.id,
            },
            include: {
                account: true,
            },
        });

        if (!originalTransaction) {
            throw new Error("Transaction not found");
        }

        // Calculate balance changes
        const oldBalanceChange = originalTransaction.type === "EXPENSE" ? -originalTransaction.amount.toNumber() : originalTransaction.amount.toNumber();

        const newBalanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;

        const netBalanceChange = newBalanceChange - oldBalanceChange;

        // Update transaction and account balance in a transaction
        const transaction = await db.$transaction(async (tx) => {
            const updated = await tx.transaction.update({
                where: {
                    id,
                    userId: user.id,
                },
                data: {
                    ...data,
                    nextRecurringDate: data.isRecurring && data.recurringInterval ? calculateNextRecurringDate(data.date, data.recurringInterval) : null,
                },
            });

            // Update account balance
            await tx.account.update({
                where: { id: data.accountId },
                data: {
                    balance: {
                        increment: netBalanceChange,
                    },
                },
            });

            return updated;
        });

        revalidatePath("/dashboard");
        revalidatePath(`/account/${data.accountId}`);

        return { success: true, data: serializeAmount(transaction) };
    } catch (error) {
        throw new Error(error.message);
    }
}