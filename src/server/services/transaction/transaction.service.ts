import { singleton } from 'tsyringe';
import { Request } from '@typings/http';
import {
  GetTransactionHistoryResponse,
  GetTransactionsInput,
  GetTransactionsResponse,
  Transaction,
  TransactionInput,
  TransactionType,
  Transfer,
  TransferType,
} from '@typings/transactions';
import { sequelize } from '../../utils/pool';
import { mainLogger } from '../../sv_logger';
import { UserService } from '../user/user.service';
import { AccountDB } from '../account/account.db';
import { TransactionDB } from './transaction.db';
import { TransactionModel } from './transaction.model';
import { ExternalAccountService } from 'services/accountExternal/externalAccount.service';
import { ServerError } from '@utils/errors';
import { GenericErrors } from '@typings/Errors';
import { AccountRole } from '@typings/Account';
import { MS_ONE_WEEK } from '@utils/constants';

const logger = mainLogger.child({ module: 'transactionService' });

@singleton()
export class TransactionService {
  _accountDB: AccountDB;
  _transactionDB: TransactionDB;
  _userService: UserService;
  _externalAccountService: ExternalAccountService;

  constructor(
    transactionDB: TransactionDB,
    userService: UserService,
    accountDB: AccountDB,
    externalAccountService: ExternalAccountService,
  ) {
    this._transactionDB = transactionDB;
    this._userService = userService;
    this._accountDB = accountDB;
    this._externalAccountService = externalAccountService;
  }

  private async getMyTransactions(req: Request<GetTransactionsInput>) {
    const user = this._userService.getUser(req.source);
    const accounts = await this._accountDB.getAccountsByIdentifier(user.getIdentifier());

    const accountIds = accounts.map((account) => account.getDataValue('id') ?? 0);
    const transactions = await this._transactionDB.getTransactionFromAccounts({
      ...req.data,
      accountIds,
    });
    const total = await this._transactionDB.getTotalTransactionsFromAccounts(accountIds);

    const mappedTransactions = transactions.map((transaction) => {
      const date = new Date(transaction.getDataValue('createdAt') ?? '');
      transaction.setDataValue('createdAt', date.toLocaleString());
      return transaction;
    });

    return {
      total: total,
      offset: req.data.offset,
      limit: req.data.limit,
      transactions: mappedTransactions,
    };
  }

  async handleGetMyTransactions(
    req: Request<GetTransactionsInput>,
  ): Promise<GetTransactionsResponse> {
    const data = await this.getMyTransactions(req);
    return {
      ...data,
      transactions: data.transactions.map((transaction) =>
        transaction.toJSON(),
      ) as unknown as Transaction[],
    };
  }

  private async handleInternalTransfer(req: Request<Transfer>) {
    logger.silly('Creating internal transfer');
    logger.silly(req);

    const t = await sequelize.transaction();
    const user = this._userService.getUser(req.source);
    const identifier = user.getIdentifier();
    const { fromAccountId, toAccountId, amount, message } = req.data;

    try {
      const myAccount = await this._accountDB.getAuthorizedAccountById(fromAccountId, identifier);
      const sharedAccount = await this._accountDB.getAuthorizedSharedAccountById(
        fromAccountId,
        identifier,
        [AccountRole.Admin, AccountRole.Owner],
      );

      const fromAccount = myAccount ?? sharedAccount;
      const toAccount = await this._accountDB.getAccount(toAccountId);

      if (!toAccount || !fromAccount) {
        throw new ServerError(GenericErrors.NotFound);
      }

      await toAccount.increment('balance', { by: amount });
      await fromAccount.decrement('balance', { by: amount });
      await this._transactionDB.create({
        amount: amount,
        message: message,
        toAccount: toAccount.toJSON(),
        type: TransactionType.Transfer,
        fromAccount: fromAccount.toJSON(),
      });

      t.commit();
    } catch (e) {
      t.rollback();
      logger.silly('Failed to create internal transfer');
      logger.silly(e);
      throw e;
    }
  }

  private async handleExternalTransfer(req: Request<Transfer>) {
    const t = await sequelize.transaction();
    try {
      const myAccount = await this._accountDB.getAccount(req.data.fromAccountId);
      const toAccount = await this._externalAccountService.getAccountFromExternalAccount(
        req.data.toAccountId,
      );

      if (!toAccount || !myAccount) {
        throw new ServerError(GenericErrors.NotFound);
      }

      await myAccount.decrement('balance', { by: req.data.amount });
      await toAccount.increment('balance', { by: req.data.amount });

      /*  Since this is a external "transfer", it's not actually a TransactionType.Transfer.
          But a seperate TransactionType.Incoming & TransactionType.Outgoing.
          
          For the person initializing the transfer, this is Outgoing.
      */
      const data = {
        amount: req.data.amount,
        message: req.data.message,
        toAccount: toAccount.toJSON(),
        fromAccount: myAccount.toJSON(),
      };

      await this._transactionDB.create({
        ...data,
        type: TransactionType.Outgoing,
      });

      await this._transactionDB.create({
        ...data,
        type: TransactionType.Incoming,
      });

      t.commit();
    } catch (e) {
      t.rollback();
      logger.silly('Failed to create internal transfer');
      logger.silly(e);
      throw e;
    }
  }

  async handleTransfer(req: Request<Transfer>) {
    logger.silly(
      `Transfering ${req.data.amount} from account ${req.data.fromAccountId} to ${req.data.toAccountId} ...`,
    );
    const isExternalTransfer = req.data.type === TransferType.External;
    if (isExternalTransfer) {
      return await this.handleExternalTransfer(req);
    }
    return await this.handleInternalTransfer(req);
  }

  async handleCreateTransaction(input: TransactionInput): Promise<TransactionModel> {
    logger.silly(`Created transaction.`);
    logger.silly(input);
    return await this._transactionDB.create(input);
  }

  async handleGetHistory(req: Request<void>): Promise<GetTransactionHistoryResponse> {
    const user = this._userService.getUser(req.source);
    const accounts = await this._accountDB.getAccountsByIdentifier(user.getIdentifier());

    const from = new Date(Date.now() - MS_ONE_WEEK);
    const accountIds = accounts.map((account) => account.getDataValue('id') ?? 0);
    const transactions = await this._transactionDB.getAllTransactionsFromAccounts(accountIds, from);

    console.log({ transactions });
    const expenses = transactions.reduce((prev, curr) => {
      const type = curr.getDataValue('type');
      const amount = curr.getDataValue('amount');
      return type === TransactionType.Outgoing ? prev - amount : prev;
    }, 0);

    const income = transactions.reduce((prev, curr) => {
      const type = curr.getDataValue('type');
      const amount = curr.getDataValue('amount');
      return type === TransactionType.Incoming ? prev + amount : prev;
    }, 0);

    const lastWeek = transactions.reduce((prev, curr) => {
      const date = new Date(curr.getDataValue('createdAt') ?? '');
      const type = curr.getDataValue('type');
      const amount = curr.getDataValue('amount');
      const isIncoming = type === TransactionType.Incoming;
      const isOutgoing = type === TransactionType.Outgoing;

      const localeDate = date.toDateString();

      const { income = 0, expenses = 0 } = prev[localeDate] ?? {};
      const newIncome = isIncoming ? income + amount : income;
      const newExpenses = isOutgoing ? expenses - amount : expenses;

      return {
        ...prev,
        [localeDate]: {
          income: newIncome,
          expenses: newExpenses,
        },
      };
    }, {} as Record<string, { income: number; expenses: number }>);

    return {
      income,
      lastWeek,
      expenses: expenses,
    };
  }
}
