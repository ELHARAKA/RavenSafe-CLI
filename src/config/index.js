'use strict';

const RVN_DONATION_ADDRESS = 'RYW4QozWJtmSipDAzXVJk2nyxRbY1fppbv';

module.exports = {
  branding: {
    donations: {
      rvn: {
        address: RVN_DONATION_ADDRESS,
        explorerUrl: `https://explorer.rvn.zelcore.io/address/${RVN_DONATION_ADDRESS}`,
      },
    },
  },
  ravencoin: {
    explorerBaseUrl: 'https://explorer.rvn.zelcore.io/api',
    feeRateSatPerByte: 1000,
    dustSats: 546,
    defaultChangeIndex: 0,
    scan: {
      balanceReceivingMaxIndex: 50,
      balanceChangeMaxIndex: 20,
      receiveMaxIndex: 100,
    },
  },
};
