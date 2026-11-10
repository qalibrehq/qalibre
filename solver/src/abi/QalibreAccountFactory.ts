export const QalibreAccountFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "entryPoint",
        "type": "address",
        "internalType": "contract IEntryPoint"
      },
      {
        "name": "settlement_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "wrappedNative",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "accountImplementation",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract QalibreAccount"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "createAccount",
    "inputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct QalibreAccountFactory.Setup",
        "components": [
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "salt",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "session",
            "type": "tuple",
            "internalType": "struct QalibreAccount.SessionSetup",
            "components": [
              {
                "name": "key",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "validUntil",
                "type": "uint48",
                "internalType": "uint48"
              },
              {
                "name": "anyBuyToken",
                "type": "bool",
                "internalType": "bool"
              },
              {
                "name": "limits",
                "type": "tuple[]",
                "internalType": "struct QalibreAccount.TokenLimit[]",
                "components": [
                  {
                    "name": "token",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "perTrade",
                    "type": "uint128",
                    "internalType": "uint128"
                  },
                  {
                    "name": "perDay",
                    "type": "uint128",
                    "internalType": "uint128"
                  }
                ]
              },
              {
                "name": "buyTokens",
                "type": "address[]",
                "internalType": "address[]"
              }
            ]
          }
        ]
      },
      {
        "name": "ownerSignature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "contract QalibreAccount"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getAddress",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "settlement",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setupHash",
    "inputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct QalibreAccountFactory.Setup",
        "components": [
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "salt",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "session",
            "type": "tuple",
            "internalType": "struct QalibreAccount.SessionSetup",
            "components": [
              {
                "name": "key",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "validUntil",
                "type": "uint48",
                "internalType": "uint48"
              },
              {
                "name": "anyBuyToken",
                "type": "bool",
                "internalType": "bool"
              },
              {
                "name": "limits",
                "type": "tuple[]",
                "internalType": "struct QalibreAccount.TokenLimit[]",
                "components": [
                  {
                    "name": "token",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "perTrade",
                    "type": "uint128",
                    "internalType": "uint128"
                  },
                  {
                    "name": "perDay",
                    "type": "uint128",
                    "internalType": "uint128"
                  }
                ]
              },
              {
                "name": "buyTokens",
                "type": "address[]",
                "internalType": "address[]"
              }
            ]
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "AccountCreated",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadOwnerSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ERC1167FailedCreateClone",
    "inputs": []
  }
] as const;
