/**
 * @file provides middleware for controllers to easily validate requests to ensure objects contain certain fields
 * and that fields are of a certain type.
 * @author David J. Thomas
 */

/**
 * Calculates limit and offset values from page and size values for GET api requests
 * @param {*} page which page of data to view
 * @param {*} size how many items per page
 * @returns 
 */
module.exports = (page, size) => {
  const limit = size ? parseInt(size, 10) : 10;
  const offset = page && page > 0 ? (page - 1) * limit : 0;
  return { limit, offset };
};