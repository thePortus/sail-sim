/**
 * @file provides middleware for controllers to easily validate requests to ensure objects contain certain fields
 * and that fields are of a certain type.
 * @author David J. Thomas
 */

/**
 * Ensures that request object has as properties every field listed in the listOfFields array. Returns a list of errors
 * 
 * @param {*} req Request object sent by the user
 * @param {Array} errorMsgs List of error messages to return if fields do not exist (may already populated with other errors)
 * @param {String} listOfFields List of fields to check for in request object
 * @returns {String} List of errors
 */
module.exports.checkFieldsExist = (req, errorMsgs, listOfFields) => {
  listOfFields.forEach(field => {
    if (!req.body[field]) {
      errorMsgs.push(`Must contain a '${field}' field!`);
    }
  });
  return errorMsgs;
};

/**
 * Checks that the values corresponding to each of the properties in the req object are of the correct type. listOfFields is an array of objects,
 * each object contains a field name and a type. (e.g. [{field: 'someField', type: 'integer'}, {field: 'anotherField', type: 'string'}]). Returns
 * a list of errors.
 * 
 * @param {*} req Request object sent by the user
 * @param {Array} errorMsgs List of error messages to return if fields do not exist (may already populated with other errors)
 * @param {Array} fieldTypes Object with two properties: field (String) and type (String)
 */
module.exports.checkFieldTypes = (req, errorMsgs, listOfFields) => {
  listOfFields.forEach(field => {
    const value = req.body[field.field];
    if (value === undefined || value === null) {
      // Skip the check if the value is not present
      return;
    }
    if (field.type === 'integer') {
      if (!Number.isInteger(value)) {
        errorMsgs.push(`'${field.field}' must be of type 'integer'!`);
      }
    } else if (typeof value !== field.type) {
      errorMsgs.push(`'${field.field}' must be of type '${field.type}'!`);
    }
  });
  return errorMsgs;

};