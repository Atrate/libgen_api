import express from 'express';
import Joi from '@hapi/joi';
import {
  ContainerTypes,
  ValidatedRequest,
  ValidatedRequestSchema,
  createValidator,
  ExpressJoiError
} from 'express-joi-validation';
import cors from 'cors';
import compression from 'compression';

import { getDownloadLink } from '../utils/scrapping';
import { search, getDownloadPage } from '../utils/libgen';
import { APIError, ErrorCode } from '../utils/error';

const argv = require('yargs')
  .option('hostname', {
    alias: 'host',
    description: 'Define the server hostname. Default: 0.0.0.0.',
    type: 'string'
  })
  .option('port', {
    alias: 'port',
    description: 'Define the server port. Default: 3000.',
    type: 'number'
  })
  .help()
  .alias('help', 'h').argv;

const port: number = argv.port ?? process.env.PORT ?? 3000;
const hostname: string = argv.hostname ?? '0.0.0.0';

const debug = require('debug')('express');

const app = express();
const validator = createValidator({ passError: true });

const searchQuerySchema = Joi.object({
  searchTerm: Joi.string()
    .required()
    .min(4),
  count: Joi.number()
    .max(20)
    .default(5),
  searchIn: Joi.string()
    .equal(
      'def',
      'title',
      'author',
      'series',
      'periodical',
      'publisher',
      'year',
      'identifier',
      'md5',
      'extension'
    )
    .default('def'),
  reverse: Joi.boolean().default(false),
  sortBy: Joi.string()
    .equal('def', 'title', 'publisher', 'year', 'pages', 'language', 'filesize', 'extension')
    .default('def'),
  offset: Joi.number().default(0)
});

const downloadQuerySchema = Joi.object({
  md5: Joi.string()
});

interface SearchRequest extends ValidatedRequestSchema {
  [ContainerTypes.Query]: {
    searchTerm: string;
    count: number;
    searchIn: string;
    reverse: boolean;
    sortBy: string;
    offset: number;
  };
}

interface DownloadRequest extends ValidatedRequestSchema {
  [ContainerTypes.Query]: {
    md5: string;
  };
}

app.use(cors());

app.use(compression());

const apiTimeout = 15000;

app.use((req, res, next) => {
  let error = new APIError();
  req.setTimeout(apiTimeout, () => {
    error.message = 'request timeout';
    error.status = ErrorCode.Timeout;
    return next(error);
  });
  res.setTimeout(apiTimeout, () => {
    error.message = 'service unavailable';
    error.status = ErrorCode.Unavailable;
    return next(error);
  });
  return next();
});

app.get(
  '/search',
  validator.query(searchQuerySchema),
  async (req: ValidatedRequest<SearchRequest>, res: express.Response, next) => {
    debug(`${req.method} ${req.url}`);
    const { data, totalCount, error } = await search(req.query);
    if (error) return next(error);
    if (res.statusCode == 503) {
      debug('request finished with timeout; preventing continuing with the flow');
      return;
    }
    debug(
      'sending results: data length = %d / total count = %d / status code = %d',
      data.length,
      totalCount,
      200
    );
    res.status(200).json({ data, totalCount });
  }
);

app.get(
  '/download',
  validator.query(downloadQuerySchema),
  async (req: ValidatedRequest<DownloadRequest>, res: express.Response, next) => {
    debug(`${req.method} ${req.url}`);
    const { downloadPageURL, error } = await getDownloadPage(req.query.md5);
    if (error) return next(error);
    if (res.statusCode == 503) {
      debug('request finished with timeout; preventing continuing with the flow');
      return;
    }
    debug('sending download page url: %s', downloadPageURL);
    res.locals.downloadPageURL = downloadPageURL;
    next();
  },
  async (req, res, next) => {
    const { downloadLink, error } = await getDownloadLink(res.locals.downloadPageURL);
    if (error) return next(error);
    if (res.statusCode == 503) {
      debug('request finished with timeout; preventing continuing with the flow');
      return;
    }
    debug('sending download link: %s', downloadLink);
    res.status(200).json({ data: { downloadLink } });
  }
);

app.use(
  (
    err: any | APIError | ExpressJoiError,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (err?.error?.isJoi) {
      err = <ExpressJoiError>err;
      debug(
        'ExpressJoiError error: status = %d / type = %s / message = %s',
        400,
        err.type,
        err.error
      );
      return res.status(400).json({
        type: err.type,
        error: err.error?.toString() ?? 'Joi error'
      });
    }

    if (err && err instanceof APIError) {
      debug('APIError: status = %d / message = %s', err.status, err.message);
      return res.status(err.status).json({
        error: err.message
      });
    }

    debug('internal error');
    return res.status(500).json({
      error: 'internal server error'
    });
  }
);

app.listen(port, hostname, () => {
  debug(`listening http://${hostname}:${port}`);
});
