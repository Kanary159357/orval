import { camel, pascal } from 'case';
import chalk from 'chalk';
import openApiValidator from 'ibm-openapi-validator';
import get from 'lodash/get';
import groupBy from 'lodash/groupBy';
import isEmpty from 'lodash/isEmpty';
import uniq from 'lodash/uniq';
import {
  ComponentsObject,
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
} from 'openapi3-ts';
import swagger2openapi from 'swagger2openapi';
import YAML from 'yamljs';

const generalJSTypes = 'number string null unknown undefined object blobpart';

/**
 * Discriminator helper for `ReferenceObject`
 *
 * @param property
 */
export const isReference = (property: any): property is ReferenceObject => {
  return Boolean(property.$ref);
};

/**
 * Return the typescript equivalent of open-api data type
 *
 * @param item
 * @ref https://github.com/OAI/OpenAPI-Specification/blob/master/versions/3.0.1.md#data-types
 */
export const getScalar = (item: SchemaObject) => {
  const nullable = item.nullable ? ' | null' : '';

  switch (item.type) {
    case 'int32':
    case 'int64':
    case 'number':
    case 'integer':
    case 'long':
    case 'float':
    case 'double':
      return { value: 'number' + nullable };

    case 'boolean':
      return { value: 'boolean' + nullable };

    case 'array': {
      const { value, imports } = getArray(item);
      return { value: value + nullable, imports };
    }

    case 'string':
    case 'byte':
    case 'binary':
    case 'date':
    case 'dateTime':
    case 'date-time':
    case 'password': {
      let value = 'string';
      let isEnum = false;

      if (item.enum) {
        value = `'${item.enum.join(`' | '`)}'`;
        isEnum = true;
      }

      if (item.format === 'binary') {
        value = 'BlobPart';
      }

      return { value: value + nullable, isEnum };
    }

    case 'object':
    default: {
      const { value, imports } = getObject(item);
      return { value: value + nullable, imports };
    }
  }
};

/**
 * Return the output type from the $ref
 *
 * @param $ref
 */
export const getRef = ($ref: ReferenceObject['$ref']) => {
  if ($ref.startsWith('#/components/schemas')) {
    return pascal($ref.replace('#/components/schemas/', ''));
  } else if ($ref.startsWith('#/components/responses')) {
    return pascal($ref.replace('#/components/responses/', '')) + 'Response';
  } else if ($ref.startsWith('#/components/parameters')) {
    return pascal($ref.replace('#/components/parameters/', '')) + 'Parameter';
  } else if ($ref.startsWith('#/components/requestBodies')) {
    return pascal($ref.replace('#/components/requestBodies/', '')) + 'RequestBody';
  } else {
    throw new Error('This library only resolve $ref that are include into `#/components/*` for now');
  }
};

/**
 * Return the output type from an array
 *
 * @param item item with type === "array"
 */
export const getArray = (item: SchemaObject): { value: string; imports?: string[] } => {
  if (item.items) {
    if (!isReference(item.items) && (item.items.oneOf || item.items.allOf)) {
      const { value, imports } = resolveValue(item.items);
      return { value: `(${value})[]`, imports };
    } else {
      const { value, imports } = resolveValue(item.items);
      return { value: `${value}[]`, imports };
    }
  } else {
    throw new Error('All arrays must have an `items` key define');
  }
};

/**
 * Return the output type from an object
 *
 * @param item item with type === "object"
 */
export const getObject = (item: SchemaObject): { value: string; imports?: string[] } => {
  if (isReference(item)) {
    const value = getRef(item.$ref);
    return { value, imports: [value] };
  }

  if (item.allOf) {
    let imports: string[] = [];
    return {
      value: item.allOf
        .map(val => {
          const resolvedValue = resolveValue(val);
          imports = [...imports, ...(resolvedValue.imports || [])];
          return resolvedValue.value;
        })
        .join(' & '),
      imports,
    };
  }

  if (item.oneOf) {
    let imports: string[] = [];
    return {
      value: item.oneOf
        .map(val => {
          const resolvedValue = resolveValue(val);
          imports = [...imports, ...(resolvedValue.imports || [])];
          return resolvedValue.value;
        })
        .join(' | '),
      imports,
    };
  }

  if (item.properties) {
    let imports: string[] = [];
    return {
      value:
        '{' +
        Object.entries(item.properties)
          .map(([key, prop]: [string, ReferenceObject | SchemaObject]) => {
            const isRequired = (item.required || []).includes(key);
            const resolvedValue = resolveValue(prop);
            imports = [...imports, ...(resolvedValue.imports || [])];
            return `${key}${isRequired ? '' : '?'}: ${resolvedValue.value}`;
          })
          .join('; ') +
        '}',
      imports,
    };
  }

  if (item.additionalProperties) {
    const { value, imports } = resolveValue(item.additionalProperties);
    return { value: `{[key: string]: ${value}}`, imports };
  }

  return { value: item.type === 'object' ? '{}' : 'any' };
};

/**
 * Resolve the value of a schema object to a proper type definition.
 * @param schema
 */
export const resolveValue = (schema: SchemaObject) => {
  if (isReference(schema)) {
    const value = getRef(schema.$ref);
    return { value, imports: [value] };
  }

  return getScalar(schema);
};

/**
 * Extract responses / request types from open-api specs
 *
 * @param responsesOrRequests reponses or requests object from open-api specs
 */
export const getResReqTypes = (
  responsesOrRequests: Array<[string, ResponseObject | ReferenceObject | RequestBodyObject]>,
) =>
  uniq(
    responsesOrRequests.map(([_, res]) => {
      if (!res) {
        return;
      }

      if (isReference(res)) {
        return getRef(res.$ref);
      } else {
        if (res.content && res.content['application/json']) {
          const schema = res.content['application/json'].schema!;
          return resolveValue(schema).value;
        } else if (res.content && res.content['application/octet-stream']) {
          const schema = res.content['application/octet-stream'].schema!;
          return resolveValue(schema).value;
        } else if (res.content && res.content['application/pdf']) {
          const schema = res.content['application/pdf'].schema!;
          return resolveValue(schema).value;
        }
        return 'unknown';
      }
    }),
  ).join(' | ');

/**
 * Return every params in a path
 *
 * @example
 * ```
 * getParamsInPath("/pet/{category}/{name}/");
 * // => ["category", "name"]
 * ```
 * @param path
 */
export const getParamsInPath = (path: string) => {
  let n;
  const output = [];
  const templatePathRegex = /\{(\w+)}/g;
  // tslint:disable-next-line:no-conditional-assignment
  while ((n = templatePathRegex.exec(path)) !== null) {
    output.push(n[1]);
  }

  return output;
};

export const getParamsTypes = ({
  params,
  pathParams,
  operation,
  type = 'definition',
}: {
  params: string[];
  pathParams: ParameterObject[];
  operation: OperationObject;
  type?: 'definition' | 'implementation';
}) => {
  return params.map(p => {
    try {
      const { name, required, schema } = pathParams.find(i => i.name === p) as {
        name: string;
        required: boolean;
        schema: SchemaObject;
      };

      if (type === 'definition') {
        return {
          name,
          definition: `${name}${!required || schema.default ? '?' : ''}: ${resolveValue(schema).value}`,
          default: schema.default,
          required,
        };
      }

      return {
        name,
        definition: `${name}${!required && !schema.default ? '?' : ''}: ${resolveValue(schema).value}${
          schema.default ? ` = ${schema.default}` : ''
        }`,
        default: schema.default,
        required,
      };
    } catch (err) {
      throw new Error(`The path params ${p} can't be found in parameters (${operation.operationId})`);
    }
  });
};

export const getQueryParamsTypes = ({
  queryParams,
  type,
}: {
  queryParams: ParameterObject[];
  type?: 'definition' | 'implementation';
}) => {
  return queryParams.map(p => {
    const { name, required, schema } = p as {
      name: string;
      required: boolean;
      schema: SchemaObject;
    };

    if (type === 'definition') {
      return {
        name,
        definition: `${name}${!required || schema.default ? '?' : ''}: ${resolveValue(schema!).value}`,
        default: schema.default,
        required,
      };
    }

    return {
      name,
      definition: `${name}${!required && !schema.default ? '?' : ''}: ${resolveValue(schema!).value}${
        schema.default ? ` = ${schema.default}` : ''
      }`,
      default: schema.default,
      required,
    };
  });
};

/**
 * Import and parse the openapi spec from a yaml/json
 *
 * @param data raw data of the spec
 * @param format format of the spec
 */
const importSpecs = (data: string, extension: 'yaml' | 'json'): Promise<OpenAPIObject> => {
  const schema = extension === 'yaml' ? YAML.parse(data) : JSON.parse(data);

  return new Promise((resolve, reject) => {
    if (!schema.openapi || !schema.openapi.startsWith('3.0')) {
      swagger2openapi.convertObj(schema, {}, (err, { openapi }) => {
        if (err) {
          reject(err);
        } else {
          resolve(openapi);
        }
      });
    } else {
      resolve(schema);
    }
  });
};

/**
 * Generate a restful-client component from openapi operation specs
 *
 * @param operation
 * @param verb
 * @param route
 * @param baseUrl
 * @param operationIds - List of `operationId` to check duplication
 */
export const getApiCall = (
  operation: OperationObject,
  verb: string,
  route: string,
  operationIds: string[],
  parameters: Array<ReferenceObject | ParameterObject> = [],
  schemasComponents?: ComponentsObject,
) => {
  if (!operation.operationId) {
    throw new Error(`Every path must have a operationId - No operationId set for ${verb} ${route}`);
  }
  if (operationIds.includes(operation.operationId)) {
    throw new Error(`"${operation.operationId}" is duplicated in your schema definition!`);
  }
  let output = '';
  operationIds.push(operation.operationId);

  route = route.replace(/\{/g, '${'); // `/pet/{id}` => `/pet/${id}`

  // Remove the last param of the route if we are in the DELETE case
  let lastParamInTheRoute: string | null = null;
  if (verb === 'delete') {
    const lastParamInTheRouteRegExp = /\/\$\{(\w+)\}$/;
    lastParamInTheRoute = (route.match(lastParamInTheRouteRegExp) || [])[1];
    route = route.replace(lastParamInTheRouteRegExp, ''); // `/pet/${id}` => `/pet`
  }
  const componentName = pascal(operation.operationId!);

  const isOk = ([statusCode]: [string, ResponseObject | ReferenceObject]) => statusCode.toString().startsWith('2');

  const responseTypes = getResReqTypes(Object.entries(operation.responses).filter(isOk));

  const requestBodyTypes = getResReqTypes([['body', operation.requestBody!]]);
  const needAResponseComponent = responseTypes.includes('{');

  const paramsInPath = getParamsInPath(route).filter(param => !(verb === 'delete' && param === lastParamInTheRoute));
  const { query: queryParams = [], path: pathParams = [] } = groupBy(
    [...parameters, ...(operation.parameters || [])].map<ParameterObject>(p => {
      if (isReference(p)) {
        return get(schemasComponents, p.$ref.replace('#/components/', '').replace('/', '.'));
      } else {
        return p;
      }
    }),
    'in',
  );

  const propsDefinition = [
    ...getParamsTypes({ params: paramsInPath, pathParams, operation }),
    ...(requestBodyTypes
      ? [{ definition: `${camel(requestBodyTypes)}: ${requestBodyTypes}`, default: false, required: false }]
      : []),
    ...(queryParams.length
      ? [
          {
            definition: `params?: { ${getQueryParamsTypes({ queryParams })
              .map(({ definition }) => definition)
              .join(', ')} }`,
            default: false,
            required: false,
          },
        ]
      : []),
  ]
    .sort((a, b) => {
      if (a.default) {
        return 1;
      }

      if (b.default) {
        return -1;
      }

      if (a.required && b.required) {
        return 1;
      }

      if (a.required) {
        return -1;
      }

      if (b.required) {
        return 1;
      }
      return 1;
    })
    .map(({ definition }) => definition)
    .join(', ');

  const props = [
    ...getParamsTypes({ params: paramsInPath, pathParams, operation, type: 'implementation' }),
    ...(requestBodyTypes
      ? [{ definition: `${camel(requestBodyTypes)}: ${requestBodyTypes}`, default: false, required: false }]
      : []),
    ...(queryParams.length
      ? [
          {
            definition: `params?: { ${getQueryParamsTypes({ queryParams, type: 'implementation' })
              .map(({ definition }) => definition)
              .join(', ')} }`,
            default: false,
            required: false,
          },
        ]
      : []),
  ]
    .sort((a, b) => {
      if (a.default) {
        return 1;
      }

      if (b.default) {
        return -1;
      }

      if (a.required && b.required) {
        return 1;
      }

      if (a.required) {
        return -1;
      }

      if (b.required) {
        return 1;
      }
      return 1;
    })
    .map(({ definition }) => definition)
    .join(', ');

  const definition = `
  ${operation.summary ? '// ' + operation.summary : ''}
  ${camel(componentName)}(${propsDefinition}): AxiosPromise<${
    needAResponseComponent ? componentName + 'Response' : responseTypes
  }>`;

  output = `  ${camel(componentName)}(${props}): AxiosPromise<${
    needAResponseComponent ? componentName + 'Response' : responseTypes
  }> {
    return axios.${verb}(\`${route}\` ${requestBodyTypes ? `, ${camel(requestBodyTypes)}` : ''} ${
    queryParams.length || responseTypes === 'BlobPart'
      ? `,
      {
        ${queryParams.length ? 'params' : ''}${queryParams.length && responseTypes === 'BlobPart' ? ',' : ''}${
          responseTypes === 'BlobPart'
            ? `responseType: 'arraybuffer',
        headers: {
          Accept: 'application/pdf',
        },`
            : ''
        }
      }`
      : ''
  });
  },
`;

  return { value: output, definition, imports: [responseTypes, requestBodyTypes] };
};

export const getApi = (specs: OpenAPIObject, operationIds: string[]) => {
  let imports: string[] = [];
  let definition = '';
  definition += `export interface ${pascal(specs.info.title)} {`;
  let value = '';
  value += `export const get${pascal(specs.info.title)} = (axios: AxiosInstance): ${pascal(specs.info.title)} => ({\n`;
  Object.entries(specs.paths).forEach(([route, verbs]: [string, PathItemObject]) => {
    Object.entries(verbs).forEach(([verb, operation]: [string, OperationObject]) => {
      if (['get', 'post', 'patch', 'put', 'delete'].includes(verb)) {
        const call = getApiCall(operation, verb, route, operationIds, verbs.parameters, specs.components);
        imports = [...imports, ...call.imports];
        definition += `${call.definition};`;
        value += call.value;
      }
    });
  });
  definition += '\n};';
  value += '})';

  return {
    output: `${definition}\n\n${value}`,
    imports: uniq(imports.filter(imp => imp && !generalJSTypes.includes(imp.toLocaleLowerCase()))),
  };
};

/**
 * Generate the interface string
 * A tslint comment is insert if the resulted object is empty
 *
 * @param name interface name
 * @param schema
 */
export const generateInterface = (name: string, schema: SchemaObject) => {
  const { value, imports } = getScalar(schema);
  const isEmptyObject = value === '{}';

  return {
    name: pascal(name),
    model: isEmptyObject
      ? `// tslint:disable-next-line:no-empty-interface
export interface ${pascal(name)} ${value}`
      : `export interface ${pascal(name)} ${value}`,
    imports,
  };
};

/**
 * Propagate every `discriminator.propertyName` mapping to the original ref
 *
 * Note: This method directly mutate the `specs` object.
 *
 * @param specs
 */
export const resolveDiscriminator = (specs: OpenAPIObject) => {
  if (specs.components && specs.components.schemas) {
    Object.values(specs.components.schemas).forEach(schema => {
      if (!schema.discriminator || !schema.discriminator.mapping) {
        return;
      }
      const { mapping, propertyName } = schema.discriminator;

      Object.entries(mapping).map(([name, ref]) => {
        if (!ref.startsWith('#/components/schemas/')) {
          throw new Error('Discriminator mapping outside of `#/components/schemas` is not supported');
        }
        if (
          specs.components &&
          specs.components.schemas &&
          specs.components.schemas[ref.slice('#/components/schemas/'.length)] &&
          specs.components.schemas[ref.slice('#/components/schemas/'.length)].properties &&
          specs.components.schemas[ref.slice('#/components/schemas/'.length)].properties![propertyName] &&
          !specs.components.schemas[ref.slice('#/components/schemas/'.length)].properties![propertyName].$ref
        ) {
          // @ts-ignore This is check on runtime
          specs.components.schemas[ref.slice('#/components/schemas/'.length)].properties![propertyName].enum = [name];
        }
      });
    });
  }
};

/**
 * Extract all types from #/components/schemas
 *
 * @param schemas
 */
export const generateSchemasDefinition = (
  schemas: ComponentsObject['schemas'] = {},
): Array<{ name: string; model: string; imports?: string[] }> => {
  if (isEmpty(schemas)) {
    return [];
  }

  const models = Object.entries(schemas).map(([name, schema]) => {
    if (
      (!schema.type || schema.type === 'object') &&
      !schema.allOf &&
      !schema.oneOf &&
      !isReference(schema) &&
      !schema.nullable
    ) {
      return generateInterface(name, schema);
    } else {
      const { value, imports, isEnum } = resolveValue(schema);

      let output = '';
      output += `export type ${pascal(name)} = ${value};`;

      if (isEnum) {
        output += `\n\nexport const ${pascal(name)} = {\n${value
          .split(' | ')
          .reduce((acc, val) => acc + `  ${val.replace(/\W|_/g, '')}: ${val} as ${pascal(name)},\n`, '')}};`;
      }

      return { name: pascal(name), model: output, imports };
    }
  });

  return models;
};

/**
 * Extract all types from #/components/responses
 *
 * @param responses
 */
export const generateResponsesDefinition = (
  responses: ComponentsObject['responses'] = {},
): Array<{ name: string; model: string; imports?: string[] }> => {
  if (isEmpty(responses)) {
    return [];
  }

  const models = Object.entries(responses).map(([name, response]) => {
    const type = getResReqTypes([['', response]]);
    const isEmptyInterface = type === '{}';

    let imports: string[] = [];
    let model = '';
    if (isEmptyInterface) {
      model = `// tslint:disable-next-line:no-empty-interface \nexport interface ${pascal(name)}Response ${type}`;
    } else if (type.includes('{') && !type.includes('|') && !type.includes('&')) {
      model = `export interface ${pascal(name)}Response ${type}`;
    } else {
      if (type) {
        imports = [...imports, type];
      }
      model = `export type ${pascal(name)}Response = ${type || 'unknown'};`;
    }

    return {
      name: `${pascal(name)}Response`,
      model,
      imports: imports.filter(imp => imp && !generalJSTypes.includes(imp.toLocaleLowerCase())),
    };
  });

  return models;
};

/**
 * Validate the spec with ibm-openapi-validator (with a custom pretty logger).
 *
 * @param specs openAPI spec
 */
const validate = async (specs: OpenAPIObject) => {
  // tslint:disable:no-console
  const log = console.log;

  // Catch the internal console.log to add some information if needed
  // because openApiValidator() calls console.log internally and
  // we want to add more context if it's used
  let wasConsoleLogCalledFromBlackBox = false;
  console.log = (...props: any) => {
    wasConsoleLogCalledFromBlackBox = true;
    log(...props);
  };
  const { errors, warnings } = await openApiValidator(specs);
  console.log = log; // reset console.log because we're done with the black box

  if (wasConsoleLogCalledFromBlackBox) {
    log('More information: https://github.com/IBM/openapi-validator/#configuration');
  }
  if (warnings.length) {
    log(chalk.yellow('(!) Warnings'));
    warnings.forEach(i =>
      log(
        chalk.yellow(`
Message : ${i.message}
Path    : ${i.path}`),
      ),
    );
  }
  if (errors.length) {
    log(chalk.red('(!) Errors'));
    errors.forEach(i =>
      log(
        chalk.red(`
Message : ${i.message}
Path    : ${i.path}`),
      ),
    );
  }
  // tslint:enable:no-console
};

/**
 * Main entry of the generator. Generate restful-client from openAPI.
 *
 * @param options.data raw data of the spec
 * @param options.format format of the spec
 * @param options.transformer custom function to transform your spec
 * @param options.validation validate the spec with ibm-openapi-validator tool
 */
const importOpenApi = async ({
  data,
  format,
  transformer,
  validation,
}: {
  data: string;
  format: 'yaml' | 'json';
  transformer?: (specs: OpenAPIObject) => OpenAPIObject;
  validation?: boolean;
}) => {
  const operationIds: string[] = [];
  let specs = await importSpecs(data, format);
  if (transformer) {
    specs = transformer(specs);
  }

  if (validation) {
    await validate(specs);
  }

  resolveDiscriminator(specs);

  const schemaDefinition = generateSchemasDefinition(specs.components && specs.components.schemas);
  const responseDefinition = generateResponsesDefinition(specs.components && specs.components.responses);

  const models = [...schemaDefinition, ...responseDefinition];

  const api = getApi(specs, operationIds);

  const base = `/* Generated by restful-client */

import { AxiosPromise, AxiosInstance } from 'axios'
`;
  return { base, api, models };
};

export default importOpenApi;
