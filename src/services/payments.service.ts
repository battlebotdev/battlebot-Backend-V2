import { confirmPayment, newPayments, PaymentsGift } from "@/dtos/payments.dto";
import { HttpException } from "@/exceptions/HttpException";
import { RequestWithUser } from "@/interfaces/auth.interface";
import paymentsModel from "@/models/payments.model";
import sellItemModel from "@/models/products.model";
import userModel from "@/models/users.model";
import { client } from "@/utils/discord";
import { tossClient, tossPaymentsClient, tossRefreshToken } from "@/utils/toss";
import { randomUUID } from "crypto";
import type { Methods } from "@tosspayments/brandpay-types";
import { Payments, PaymentsMethods } from "@/interfaces/payments.interface";
import { guildPremiumHanler } from "@/utils/premium";
import premiumGuildModel from "@/models/premiumGuild.model";
import premiumUserModel from "@/models/premiumUser.model";
import { Document } from "mongoose";
import { Request } from "express";

class PaymentsService {
  public async getPayementsAuth(req: RequestWithUser): Promise<any> {
    const { code, customerKey } = req.query;
    if (!code) throw new HttpException(400, req.t("notNeedParams"));
    if (!customerKey) throw new HttpException(400, req.t("notNeedParams"));
    if (req.user.id !== customerKey)
      throw new HttpException(401, req.t("auth.unauthorization"));
    const authData = await tossClient(
      "POST",
      "/v1/brandpay/authorizations/access-token",
      {
        grantType: "AuthorizationCode",
        code,
        customerKey,
      }
    );
    await userModel.updateOne(
      { id: req.user.id },
      {
        $set: {
          toss_accessToken: authData.data.accessToken,
          toss_refreshToken: authData.data.refreshToken,
          toss_tokenType: authData.data.tokenType,
        },
      }
    );
    if (authData.error)
      throw new HttpException(
        401,
        authData.message ? authData.message : req.t("auth.unauthorization")
      );
    return authData;
  }

  public async getPaymentsMethods(req: RequestWithUser): Promise<any> {
    let tossMethodsData = await tossClient(
      "GET",
      "/v1/brandpay/payments/methods",
      null,
      req.user.toss_accessToken as string
    );
    if (tossMethodsData.data.code === "INVALID_ACCESS_TOKEN") {
      const refreshToken = await tossRefreshToken(req.user);
      if (!refreshToken)
        throw new HttpException(401, req.t("auth.unauthorization"));
      tossMethodsData = await tossClient(
        "GET",
        "/v1/brandpay/payments/methods",
        null,
        refreshToken.accessToken as string
      );
    }
    if (tossMethodsData.error)
      throw new HttpException(
        401,
        tossMethodsData.message
          ? tossMethodsData.message
          : req.t("auth.unauthorization")
      );
    const methodsData: Methods = tossMethodsData.data;
    const methods: PaymentsMethods[] = [];
    methodsData.accounts.forEach((account) => {
      return methods.push({
        type: "account",
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        id: account.id,
        iconUrl: account.iconUrl,
        select: methodsData.selectedMethodId === account.id ? true : false,
      });
    });
    methodsData.cards.forEach((card) => {
      return methods.push({
        type: "card",
        cardName: card.cardName,
        cardNumber: card.cardNumber,
        cardType: card.cardType,
        id: card.id,
        iconUrl: card.iconUrl,
        select: methodsData.selectedMethodId === card.id ? true : false,
      });
    });
    return methods;
  }

  public async confirmPayment(req: RequestWithUser): Promise<any> {
    const { amount, orderId, paymentKey, phone } = req.body as confirmPayment;
    const confirmData = await tossClient("POST", `/v1/payments/${paymentKey}`, {
      orderId,
      amount,
    });
    if (confirmData.error)
      throw new HttpException(
        confirmData.status ? confirmData.status : 500,
        confirmData.message ? confirmData.message : req.t("payments.error")
      );
    const payments = await paymentsModel.findOne({ orderId });
    await userModel.updateOne({ id: req.user.id }, { $set: { phone } });
    await paymentsModel.updateOne(
      { orderId },
      { $set: { payment: confirmData.data, process: "success" } }
    );
    await guildPremiumHanler(payments.target, payments.item, req.user.id);
    return confirmData.data;
  }

  public async getSuccessOrderCultureland(req: RequestWithUser): Promise<any> {
    const { orderId, amount, paymentKey, phone } = req.body as PaymentsGift;
    const payments = await paymentsModel.findOne({
      orderId: orderId,
    });
    if (!payments) throw new HttpException(404, req.t("payments.notFoundOrder"));
    if (payments.process === "success") throw new HttpException(409, req.t("payments.alreadySuccessOrder"));
    const orderCulturelandData = await tossPaymentsClient(
      "POST",
      `/v1/payments/confirm`,
      {
        orderId,
        amount,
        paymentKey,
      }
    );
    if (orderCulturelandData.error) {
      throw new HttpException(
        orderCulturelandData.status ? orderCulturelandData.status : 500,
        orderCulturelandData.message ? orderCulturelandData.message : req.t("payments.error")
      );
    }
    await userModel.updateOne({ id: req.user.id }, { $set: { phone } });
    await paymentsModel.updateOne(
      { orderId },
      { $set: { payment: orderCulturelandData.data, process: "success" } }
    );
    await guildPremiumHanler(payments.target, payments.item, req.user.id);
    const paymentsMeta = await this.getPaymentsMetadata(orderId, req)
    return paymentsMeta;
  }

  public async addNewOrder(req: RequestWithUser): Promise<any> {
    const paymentsReq: newPayments = req.body;
    const user = req.user;
    const orderId = randomUUID();
    const item = await sellItemModel.findOne({ itemId: paymentsReq.itemId });
    if (!item) throw new HttpException(404, req.t("order.notFoundItem"));
    const paymentsDB = new paymentsModel({
      userId: user.id,
      orderId: orderId,
      amount: item.amount,
      process: "open",
      name: item.itemName,
      target: paymentsReq.guildId,
      type: item.type,
      item: paymentsReq.itemId,
    });
    await paymentsDB.save().catch(() => {
      throw new HttpException(500, req.t("order.error"));
    });
    return {
      paymentId: orderId,
    };
  }

  public async getSuccessOrder(req: RequestWithUser): Promise<any> {
    const payments = await paymentsModel.findOne({
      orderId: req.params.orderId,
    });
    if (!payments || req.user.id !== payments.userId)
      throw new HttpException(404, req.t("payments.notFoundPayments"));
    const paymentsMeta = await this.getPaymentsMetadata(req.params.orderId, req)
    return paymentsMeta;
  }

  public async getOrder(req: RequestWithUser): Promise<any> {
    const payments = await paymentsModel.findOne({
      orderId: req.params.orderId,
    });
    if (!payments || payments.userId !== req.user.id)
      throw new HttpException(404, req.t("payments.notFoundPayments"));
    if (payments.process === "success")
      throw new HttpException(400, req.t("payments.alreadySuccessPayments"));
    let itemMetadata;
    if (payments.type === "guild") {
      const guild = client.guilds.cache.get(payments.target);
      if (!guild)
        throw new HttpException(404, req.t("payments.notFoundServer"));
      itemMetadata = {
        type: "guild",
        id: guild.id,
        icon: guild.icon,
        name: guild.name,
      };
    } else if (payments.type === "user") {
      const user = client.users.cache.get(payments.target);
      if (!user)
        throw new HttpException(404, req.t("payments.notFoundUser"));
      itemMetadata = {
        type: "user",
        id: user.id,
        avatar: user.avatar,
        discriminator: user.discriminator,
        name: user.username,
      };
    }
    return {
      metadata: itemMetadata,
      name: payments.name,
      id: payments.orderId,
      amount: payments.amount,
    };
  }

  private async getPaymentsMetadata(orderId: string, req: Request): Promise<any> {
    const payments = await paymentsModel.findOne({ orderId });
    let itemMetadata;
    let nextPayDate: Date;
    if (payments.type === "guild") {
      const guild = client.guilds.cache.get(payments.target);
      if (!guild)
        throw new HttpException(404, req.t("payments.notFoundPaymentsServer"));
      itemMetadata = {
        type: "guild",
        id: guild.id,
        icon: guild.icon,
        name: guild.name,
      };
      const guildPremium = await premiumGuildModel.findOne({
        guild_id: guild.id,
      });
      nextPayDate = guildPremium.nextpay_date;
    } else if (payments.type === "user") {
      const user = client.users.cache.get(payments.target);
      if (!user)
        throw new HttpException(404, req.t("payments.notFoundPaymentsUser"));
      itemMetadata = {
        type: "user",
        id: user.id,
        avatar: user.avatar,
        discriminator: user.discriminator,
        name: user.username,
      };
      const userPremium = await premiumUserModel.findOne({ user_id: user.id });
      nextPayDate = userPremium.nextpay_date;
    }
    return {
      metadata: itemMetadata,
      nextPayDate,
      ...payments.toJSON(),
    }
  }
}

export default PaymentsService;