import dotProp from 'dot-prop-immutable';
import logger from './utils/logger';
import CacheService from './utils/cache-service';
import merge from './utils/deepmerge';
import AWS from 'aws-sdk';

const S3_SUFFIX = '.s3.amazonaws.com';
const ORIGIN_S3_DOTPATH = 'Records.0.cf.request.origin.s3';

const ttl = 300; // default TTL of 30 seconds
const cache = new CacheService(ttl);

let DDB;
const rerouteOrigin = async (opts = {}, handler, next) => {
  const { context } = handler;
  const { request } = handler.event.Records[0].cf;
  const { origin } = request;
  const [host] = getHeaderValues(['host'], request.headers);
  const s3DomainName = origin && origin.s3 && origin.s3.domainName;
  const originBucket = s3DomainName && s3DomainName.replace(S3_SUFFIX, '');

  const tableSuffix = '-domainmap';
  const functionSuffix = '-originrequest';
  const defaults = {
    functionSuffix,
    tableSuffix,
    tableName: getTableFromFunctionName(
      context.functionName,
      opts.functionSuffix || functionSuffix,
      opts.tableSuffix || tableSuffix,
    ),
    cacheTtl: ttl,
  };
  const options = merge(defaults, opts);
  cache.setDefaultTtl(options.cacheTtl);

  DDB =
    DDB ||
    new AWS.DynamoDB({
      apiVersion: '2012-08-10',
      region: 'us-east-1',
    });

  logger(`
    Raw Event:
    ${JSON.stringify(handler.event)}

    Middleware Options:
    ${JSON.stringify(options)}
    ---- Request ----
    URI: ${request.uri}
    Host: ${host}
    Origin: ${s3DomainName}
    `);

  try {
    const domainData = await getDomainData(options.tableName, host);
    logger({ domainData });
    handler.event = !!domainData
      ? dotProp.merge(handler.event, ORIGIN_S3_DOTPATH, {
          region: domainData.region,
          domainName: domainData.origin,
        })
      : handler.event;
  } catch (err) {
    logger('Throwing Error for main thread');
    throw err;
  }

  return;
};

export default opts => ({
  before: rerouteOrigin.bind(null, opts),
});

///////////////////////
// Utils     //
///////////////////////
const getHeaderValues = (paramArr, headers) =>
  paramArr.map(
    param => headers[param] && headers[param][0] && headers[param][0].value,
  );

// from:  us-east-1.myproject-prod-originrequest
// to:    myproject-prod-domainmap
const getTableFromFunctionName = (
  functionName,
  functionSuffix,
  tableSuffix,
) => {
  logger(`
  getTableFromFunctionName:
  ${JSON.stringify({ functionName, functionSuffix, tableSuffix })}
  `);
  const [rest, stackname] =
    functionName.match(`^(?:us-east-1\.)?(.+)${functionSuffix}$`) || [];
  return `${stackname}${tableSuffix}`;
};

const getDomainData = (table, host) =>
  cache.get(`getDomainData_${host}`, () =>
    DDB.getItem({
      Key: {
        Host: {
          S: host,
        },
      },
      TableName: table,
    })
      .promise()
      .then(data => {
        logger(`
      getDomainData: 
      ${JSON.stringify(data)}`);
        return (
          data.Item &&
          data.Item.Origin &&
          data.Item.Origin.S && {
            host: data.Item.Host.S,
            origin: data.Item.Origin.S,
            region: (data.Item.Region && data.Item.Region.S) || 'us-east-1',
          }
        );
      }),
  );
