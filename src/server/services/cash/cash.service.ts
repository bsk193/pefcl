import { singleton } from 'tsyringe';
import { Cash } from '../../../../typings/Cash';
import { AccountServiceExports } from '../../../../typings/exports';
import { config } from '@utils/server-config';
import { mainLogger } from '../../sv_logger';
import { UserService } from '../user/user.service';
import { CashDB } from './cash.db';
import { CashModel } from './cash.model';

const exp: AccountServiceExports = global.exports[config?.exports?.resourceName ?? 'no-use'];
const logger = mainLogger.child({ module: 'cash' });

@singleton()
export class CashService {
  _cashDB: CashDB;
  _userService: UserService;

  constructor(cashDB: CashDB, userService: UserService) {
    this._cashDB = cashDB;
    this._userService = userService;
  }

  private async getCashModel(source: number): Promise<CashModel | null> {
    const user = this._userService.getUser(source);
    return await this._cashDB.getCashByIdentifier(user?.getIdentifier() ?? '');
  }

  async getMyCash(source: number): Promise<number> {
    const user = this._userService.getUser(source);
    if (config?.general?.useFrameworkIntegration) {
      return user?.getBalance() ?? 0;
    }

    const cash = await this.getCashModel(source);
    return cash?.getDataValue('amount') ?? 0;
  }

  async createInitialCash(source: number): Promise<Cash> {
    const user = this._userService.getUser(source);
    logger.debug(`Creating initial cash row for ${user?.getIdentifier() ?? ''}`);
    const cash = await this._cashDB.createInitial(user?.getIdentifier() ?? '');
    return cash.toJSON();
  }

  async handleTakeCash(source: number, amount: number): Promise<CashModel | null> {
    logger.debug(`Taking ${amount} from ${source}`);
    const user = this._userService.getUser(source);
    const identifier = user.getIdentifier();

    if (config?.general?.useFrameworkIntegration) {
      exp.pefclDepositMoney(source, amount);
      return null;
    }

    const cash = await this._cashDB.getCashByIdentifier(identifier);
    await cash?.decrement({ amount });

    return cash;
  }

  async handleGiveCash(source: number, amount: number): Promise<CashModel | null> {
    logger.debug(`Giving ${amount} to ${source}`);
    const user = this._userService.getUser(source);
    const identifier = user.getIdentifier();

    if (config?.general?.useFrameworkIntegration) {
      exp.pefclWithdrawMoney(source, amount);
      return null;
    }

    const cash = await this._cashDB.getCashByIdentifier(identifier);
    await cash?.increment({ amount });

    return cash;
  }
}
