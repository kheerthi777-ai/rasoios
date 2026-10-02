const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    service: "RasoiOS Mock Rails Server",
  });
});

app.post("/maps/api/verify", (req, res) => {
  const address = req.body && req.body.address;
  if (address == null || String(address).trim() === "") {
    return res.status(400).json({
      error: "address is required",
    });
  }

  return res.json({
    is_verified: true,
    granularity: "PREMISE",
    standardised_address:
      "Flat 402, Sea Breeze Apartments, Palm Beach Rd, Sanpada, Navi Mumbai, Maharashtra 400705",
    coordinates: { lat: 19.0657, lng: 73.0104 },
  });
});

app.post("/cmu/pushorder", (_req, res) => {
  res.json({
    status: "Success",
    packages: [
      {
        waybill: "98273410293",
        refnum: "REF_12345",
        status: "Manifested",
      },
    ],
  });
});

app.post("/api/v1/pinelabs/mandate/dynamic-switch", (req, res) => {
  const rawAmount = req.body && req.body.cart_amount;
  const cartAmount = Number(rawAmount);
  const amount = Number.isFinite(cartAmount) ? cartAmount : 0;

  if (amount > 300) {
    return res.status(422).json({
      status: "DECLINED",
      error_code: "GRANTEX_CAP_BREACH",
      message:
        "Cart amount exceeds ₹300 ceiling. Halting for user authorization.",
    });
  }

  if (amount > 250) {
    return res.status(200).json({
      status: "FALLBACK_OTM_EXECUTED",
      auth_code: "OTM_AUTH_9912",
      pool_remaining: 0,
      fallback_triggered: true,
    });
  }

  return res.status(200).json({
    status: "SETTLED_RESERVEPAY",
    auth_code: "SBMD_AUTH_5512",
    pool_remaining: 1720 - amount,
    fallback_triggered: false,
  });
});

app.post("/api/v1/delhivery/hyperlocal/dispatch", (req, res) => {
  const skuList = req.body && req.body.sku_list;
  const missing =
    skuList == null ||
    (typeof skuList === "string" && skuList.trim() === "") ||
    (Array.isArray(skuList) && skuList.length === 0);

  if (missing) {
    return res.status(400).json({
      error: "sku_list is required",
    });
  }

  return res.json({
    order_id: "DLH_HYPER_4491",
    darkstore_id: "DS_WEST_SANPADA",
    eta_minutes: 22,
    status: "DISPATCHED",
    items_reserved: skuList,
  });
});

app.post("/api/v1/delhivery/navigation/premise-instructions", (req, res) => {
  const body = req.body || {};
  res.json({
    instruction_token: "INST_NAV_002",
    delivery_protocol: body.drop_type || "LEAVE_AT_DOORSTEP_BOX_SILENT",
    gate_clearance_code: body.gate_code || "GATE_VERIFIED",
    requires_call: false,
  });
});

const port = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`RasoiOS Mock Rails Server listening on port ${port}`);
  });
}

module.exports = app;
